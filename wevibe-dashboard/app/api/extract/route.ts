import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';
import type { MemoryCandidate } from '@/lib/session-types';

export const dynamic = 'force-dynamic';
const MCP_SESSION_TOKEN_PATH = path.join(
  homedir(),
  '.wevibe',
  'mcp-session-token',
);

interface ExtractRequestBody {
  transcript: string;
  title?: string;
  directory?: string;
  model?: string;
  stack?: string[];
}

async function readMcpSessionToken(): Promise<string | null> {
  try {
    const token = (await readFile(MCP_SESSION_TOKEN_PATH, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

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
		&& value.memory_type === 'memory'
	);
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ExtractRequestBody;

  if (!body.transcript || body.transcript.trim().length < 50) {
    return NextResponse.json(
      { error: 'Session transcript too short for extraction' },
      { status: 400 },
    );
  }

  let sessionToken: string | null;
  try {
    sessionToken = await readMcpSessionToken();
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to read MCP session token: ${(error as Error).message}` },
      { status: 500 },
    );
  }

  if (!sessionToken) {
    return NextResponse.json(
      { error: 'local WeVibe MCP not running (no session token)' },
      { status: 503 },
    );
  }

  const mcpHttpUrl = getMcpHttpUrl();
  const extractUrl = new URL('/v1/extract', mcpHttpUrl).toString();

  const projectContext: {
    title: string;
    directory: string;
    stack?: string[];
  } = {
    title: body.title ?? 'unknown',
    directory: body.directory ?? 'unknown',
  };

  if (Array.isArray(body.stack) && body.stack.every((entry) => typeof entry === 'string')) {
    projectContext.stack = body.stack;
  }

  let response: Response;
  try {
    response = await fetch(extractUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        transcript: body.transcript,
        project_context: projectContext,
      }),
    });
  } catch {
    return NextResponse.json(
      { error: `local WeVibe MCP unreachable at ${mcpHttpUrl}` },
      { status: 503 },
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    const errorMessage =
      isRecord(responseBody) && typeof responseBody.error === 'string'
        ? responseBody.error
        : `MCP extraction failed with status ${response.status}`;

    return NextResponse.json({ error: errorMessage }, { status: response.status });
  }

  if (!isRecord(responseBody) || !Array.isArray(responseBody.memories)) {
    return NextResponse.json(
      { error: 'MCP extraction returned invalid memory payload' },
      { status: 502 },
    );
  }

  const memories = responseBody.memories;
  if (!memories.every(isMemoryCandidate)) {
    return NextResponse.json(
      { error: 'MCP extraction returned invalid memory payload' },
      { status: 502 },
    );
  }

  return NextResponse.json({ memories });
}
