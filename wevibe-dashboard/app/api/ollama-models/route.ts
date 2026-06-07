import { NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

interface OllamaTagsResponse {
  models?: Array<{
    name?: unknown;
  }>;
}

export async function GET() {
  try {
    const { ollama_url } = loadSettings();
    const response = await fetch(`${ollama_url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Ollama models (${response.status}).`);
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const models = Array.isArray(payload.models)
      ? payload.models
        .map((entry) => (typeof entry.name === 'string' ? entry.name : ''))
        .filter((name): name is string => name.length > 0)
        .sort((a, b) => a.localeCompare(b))
      : [];

    return NextResponse.json({ models });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch Ollama models.';
    return NextResponse.json(
      {
        models: [],
        error: message,
      },
      { status: 200 },
    );
  }
}
