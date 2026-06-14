import { NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

interface LmStudioModelsResponse {
  data?: Array<{
    id?: unknown;
  }>;
}

export async function GET() {
  try {
    const { lmstudio_url } = loadSettings();
    const response = await fetch(`${lmstudio_url.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch LM Studio models (${response.status}).`);
    }

    const payload = (await response.json()) as LmStudioModelsResponse;
    const models = Array.isArray(payload.data)
      ? payload.data
        .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
        .filter((id): id is string => id.length > 0)
        .sort((a, b) => a.localeCompare(b))
      : [];

    return NextResponse.json({ models });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch LM Studio models.';
    return NextResponse.json(
      {
        models: [],
        error: message,
      },
      { status: 200 },
    );
  }
}
