import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface OpenRouterModelEntry {
  id?: unknown;
  name?: unknown;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelEntry[];
}

export async function GET() {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch OpenRouter models (${response.status}).`);
    }

    const payload = (await response.json()) as OpenRouterModelsResponse;

    const models = Array.isArray(payload.data)
      ? payload.data
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }

          if (typeof entry.id !== 'string' || entry.id.length === 0) {
            return null;
          }

          return {
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
          };
        })
        .filter((entry): entry is { id: string; name: string } => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      : [];

    return NextResponse.json({ models });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch OpenRouter models.';
    return NextResponse.json(
      {
        models: [],
        error: message,
      },
      { status: 200 },
    );
  }
}
