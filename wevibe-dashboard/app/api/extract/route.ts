import { NextRequest, NextResponse } from 'next/server';
import { getMcpClient } from '@/lib/mcp-client';
import type { MemoryCandidate } from '@/lib/session-types';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMemoryCandidate(value: unknown): value is MemoryCandidate {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.insight === 'string'
    && typeof value.context === 'string'
    && (value.avoid === null || typeof value.avoid === 'string')
    && Array.isArray(value.stack)
    && value.stack.every((entry) => typeof entry === 'string')
    && (value.memory_type === 'correct_implementation' || value.memory_type === 'negative_signal')
  );
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    transcript: string;
    title?: string;
    directory?: string;
    model?: string;
  };

  if (!body.transcript || body.transcript.trim().length < 50) {
    return NextResponse.json(
      { error: 'Session transcript too short for extraction' },
      { status: 400 },
    );
  }

  const mcpClient = getMcpClient();

  try {
    const result = await mcpClient.callTool('wevibe_extract_memories', {
      transcript: body.transcript,
      project_context: {
        title: body.title ?? 'unknown',
        directory: body.directory ?? 'unknown',
      },
    });

    if (!Array.isArray(result) || !result.every(isMemoryCandidate)) {
      throw new Error('MCP extraction returned invalid memory payload');
    }

    return NextResponse.json({ memories: result });
  } catch (err) {
    return NextResponse.json(
      { error: `MCP extraction failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
