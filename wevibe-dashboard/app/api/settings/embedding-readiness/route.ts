import { NextResponse } from 'next/server';
import { loadSettings, type DashboardSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const PROBE_INPUT = 'wevibe embedding readiness probe';
const EMBEDDING_PROBE_ATTEMPTS = 3;
const EMBEDDING_PROBE_BACKOFF_MS = [600, 1200] as const;

interface EmbeddingResponseEntry {
  embedding?: unknown;
}

interface EmbeddingResponsePayload {
  data?: EmbeddingResponseEntry[];
  error?: unknown;
  message?: unknown;
}

function getSelectedModel(settings: DashboardSettings): string {
  if (settings.embedding_provider === 'openrouter') {
    return settings.embedding_openrouter_model;
  }

  if (settings.embedding_provider === 'lm_studio') {
    return settings.embedding_lmstudio_model;
  }

  return settings.embedding_ollama_model;
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const responsePayload = payload as EmbeddingResponsePayload;

  if (typeof responsePayload.message === 'string' && responsePayload.message.length > 0) {
    return responsePayload.message;
  }

  if (typeof responsePayload.error === 'string' && responsePayload.error.length > 0) {
    return responsePayload.error;
  }

  if (
    responsePayload.error &&
    typeof responsePayload.error === 'object' &&
    'message' in responsePayload.error &&
    typeof responsePayload.error.message === 'string' &&
    responsePayload.error.message.length > 0
  ) {
    return responsePayload.error.message;
  }

  return null;
}

function extractEmbeddingDimension(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const responsePayload = payload as EmbeddingResponsePayload;

  if (!Array.isArray(responsePayload.data) || responsePayload.data.length === 0) {
    return null;
  }

  const embedding = responsePayload.data[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return null;
  }

  return embedding.length;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function buildProbeFailureReason(status: number, payload: unknown): string {
  const detail = extractErrorMessage(payload);
  return detail
    ? `Embedding probe failed (${status}): ${detail}`
    : `Embedding probe failed (${status})`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function GET() {
  const settings = loadSettings();
  const provider = settings.embedding_provider;
  const model = getSelectedModel(settings);

  let url: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (provider === 'openrouter') {
    const apiKey = settings.openrouter_api_key.trim();
    if (apiKey.length === 0 || apiKey.startsWith('••••')) {
      return NextResponse.json({
        ready: false,
        dim: null,
        provider,
        model,
        reason: 'OpenRouter API key not set',
      });
    }

    headers.Authorization = `Bearer ${apiKey}`;
    url = 'https://openrouter.ai/api/v1/embeddings';
  } else if (provider === 'lm_studio') {
    url = `${settings.lmstudio_url.replace(/\/$/, '')}/embeddings`;
  } else {
    url = `${settings.ollama_url.replace(/\/$/, '')}/v1/embeddings`;
  }

  if (model.trim().length === 0) {
    return NextResponse.json({
      ready: false,
      dim: null,
      provider,
      model,
      reason: 'Embedding model not set',
    });
  }

  for (let attempt = 1; attempt <= EMBEDDING_PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const backoff = EMBEDDING_PROBE_BACKOFF_MS[attempt - 2];
      await wait(backoff);
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          input: PROBE_INPUT,
        }),
        signal: AbortSignal.timeout(12000),
      });

      let payload: unknown = null;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const reason = buildProbeFailureReason(response.status, payload);

        if (isRetryableStatus(response.status) && attempt < EMBEDDING_PROBE_ATTEMPTS) {
          continue;
        }

        return NextResponse.json({
          ready: false,
          dim: null,
          provider,
          model,
          reason,
        });
      }

      const dim = extractEmbeddingDimension(payload);
      if (dim === null) {
        return NextResponse.json({
          ready: false,
          dim: null,
          provider,
          model,
          reason: 'Embedding response missing data[0].embedding',
        });
      }

      return NextResponse.json({
        ready: true,
        dim,
        provider,
        model,
        reason: null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Embedding probe failed';

      if (attempt < EMBEDDING_PROBE_ATTEMPTS) {
        continue;
      }

      return NextResponse.json({
        ready: false,
        dim: null,
        provider,
        model,
        reason: message,
      });
    }
  }

  return NextResponse.json({
    ready: false,
    dim: null,
    provider,
    model,
    reason: 'Embedding probe failed',
  });
}
