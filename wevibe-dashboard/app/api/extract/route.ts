import { NextRequest, NextResponse } from 'next/server';
import { getMcpClient } from '@/lib/mcp-client';

export const dynamic = 'force-dynamic';

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
    const result = await mcpClient.callTool<{ memories: unknown[] }>('wevibe_extract_memories', {
      transcript: body.transcript,
      project_context: {
        title: body.title ?? 'unknown',
        directory: body.directory ?? 'unknown',
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `MCP extraction failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
