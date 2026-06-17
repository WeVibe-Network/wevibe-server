import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

const MCP_SESSION_TOKEN_PATH = path.join(
  homedir(),
  '.wevibe',
  'mcp-session-token',
);

interface ProvisionRecallRequestBody {
  org_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  if (!isRecord(rawBody)) {
    return NextResponse.json({ error: 'org_id is required' }, { status: 400 });
  }

  const { org_id: orgId } = rawBody;
  if (!isNonEmptyString(orgId)) {
    return NextResponse.json({ error: 'org_id is required' }, { status: 400 });
  }

  const body: ProvisionRecallRequestBody = {
    org_id: orgId.trim(),
  };

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
  const provisionRecallUrl = new URL('/v1/provision-recall', mcpHttpUrl).toString();

  let response: Response;
  try {
    response = await fetch(provisionRecallUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ error: 'local WeVibe MCP unreachable' }, { status: 503 });
  }

  const responseBody = (await response.json()) as unknown;
  return NextResponse.json(responseBody, { status: response.status });
}
