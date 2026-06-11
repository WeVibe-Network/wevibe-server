import { NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOpenRouterModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .map((entry) => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : ''))
    .filter((id): id is string => id.length > 0);
}

function readOllamaModelNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    return [];
  }

  return payload.models
    .map((entry) => (isRecord(entry) && typeof entry.name === 'string' ? entry.name : ''))
    .filter((name): name is string => name.length > 0);
}

export async function POST() {
  try {
    const settings = loadSettings();

    if (settings.llm_provider === 'openrouter') {
      const key = settings.openrouter_api_key.trim();
      const model = settings.openrouter_model.trim();

      if (key.length === 0) {
        return NextResponse.json({ ok: false, detail: 'No OpenRouter API key saved.' });
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 4000);

      let response: Response;
      try {
        response = await fetch('https://openrouter.ai/api/v1/models', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
          },
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch {
        return NextResponse.json({
          ok: false,
          detail: 'Could not reach OpenRouter to validate the API key.',
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        return NextResponse.json({
          ok: false,
          detail: `OpenRouter rejected the API key (HTTP ${response.status}).`,
        });
      }

      const modelIds = readOpenRouterModelIds(await response.json());

      if (model.length > 0 && !modelIds.includes(model)) {
        return NextResponse.json({
          ok: true,
          detail: `Key valid. Note: model "${model}" was not in the public model list (may still work if private/allowed).`,
        });
      }

      return NextResponse.json({
        ok: true,
        detail: `OpenRouter key valid; model "${model}" available.`,
      });
    }

    const ollamaUrl = settings.ollama_url.trim();
    const model = settings.ollama_model.trim();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 4000);

    let response: Response;
    try {
      response = await fetch(`${ollamaUrl}/api/tags`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      return NextResponse.json({
        ok: false,
        detail: `Could not reach Ollama at ${ollamaUrl}.`,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return NextResponse.json({
        ok: false,
        detail: `Could not reach Ollama at ${ollamaUrl}.`,
      });
    }

    const modelNames = readOllamaModelNames(await response.json());

    if (!modelNames.includes(model)) {
      return NextResponse.json({
        ok: false,
        detail: `Ollama is reachable but model "${model}" is not pulled. Run: ollama pull ${model}.`,
      });
    }

    return NextResponse.json({
      ok: true,
      detail: `Ollama reachable; model "${model}" available.`,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error
      ? error.message
      : 'Unexpected settings test failure.';
    return NextResponse.json({ ok: false, detail }, { status: 500 });
  }
}
