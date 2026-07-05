import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';
import {
  MCP_OFFLINE_CODE,
  MCP_OFFLINE_ERROR,
  MCP_OFFLINE_REMEDIATION,
} from '@/lib/mcp-errors';

export const dynamic = 'force-dynamic';

const MCP_SESSION_TOKEN_PATH = path.join(
  homedir(),
  '.wevibe',
  'mcp-session-token',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();

  logOp('dashboard.identity_adopt_local', 'info', {
    trace,
    phase: 'entry',
    method: 'POST',
  });

  let sessionToken: string | null;
  try {
    sessionToken = await readMcpSessionToken();
  } catch (error) {
    logOp('dashboard.identity_adopt_local', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      dur_ms: Date.now() - startedAt,
      err: (error as Error).message,
    });
    return NextResponse.json(
      { error: `Failed to read MCP session token: ${(error as Error).message}` },
      { status: 500 },
    );
  }

  if (!sessionToken) {
    return NextResponse.json(
      { error: MCP_OFFLINE_ERROR, code: MCP_OFFLINE_CODE, remediation: MCP_OFFLINE_REMEDIATION },
      { status: 503 },
    );
  }

  const exportPairingUrl = new URL('/v1/identity/export-pairing', getMcpHttpUrl()).toString();

  let response: Response;
  try {
    response = await fetch(exportPairingUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        [TRACE_HEADER]: trace,
      },
    });
  } catch {
    logOp('dashboard.identity_adopt_local', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      proxy_target: exportPairingUrl,
      dur_ms: Date.now() - startedAt,
      err: 'mcp_unreachable',
    });
    return NextResponse.json({ error: 'local WeVibe MCP unreachable' }, { status: 503 });
  }

  const responseBody = (await response.json().catch(() => null)) as unknown;
  logOp('dashboard.identity_adopt_local', response.status >= 400 ? 'warn' : 'info', {
    trace,
    phase: 'outcome',
    status: response.status >= 400 ? 'err' : 'ok',
    proxy_target: exportPairingUrl,
    upstream_status: response.status,
    dur_ms: Date.now() - startedAt,
    token_present: Boolean(sessionToken),
  });

  if (response.status === 404 && isRecord(responseBody) && responseBody.error === 'no_identity') {
    return NextResponse.json({ error: 'no_identity' }, { status: 404 });
  }

  if (!response.ok) {
    if (isRecord(responseBody) && typeof responseBody.error === 'string') {
      return NextResponse.json({ error: responseBody.error }, { status: response.status });
    }

    return NextResponse.json(
      { error: 'Failed to export identity pairing code from local WeVibe MCP.' },
      { status: response.status },
    );
  }

  if (!isRecord(responseBody) || typeof responseBody.code !== 'string') {
    return NextResponse.json({ error: 'Invalid response from local WeVibe MCP.' }, { status: 502 });
  }

  return NextResponse.json({ code: responseBody.code }, { status: 200 });
}
