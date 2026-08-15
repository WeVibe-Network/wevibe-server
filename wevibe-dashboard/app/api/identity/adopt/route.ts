import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';
import { fp, logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';
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

const SEED_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

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

  logOp('dashboard.identity_back_push', 'info', {
    trace,
    phase: 'entry',
    method: 'POST',
  });

  const body = (await request.json().catch(() => null)) as unknown;
  const seedHex =
    isRecord(body) && typeof body.seed_hex === 'string' ? body.seed_hex : '';
  if (!SEED_HEX_PATTERN.test(seedHex)) {
    logOp('dashboard.identity_back_push', 'warn', {
      trace,
      phase: 'outcome',
      status: 'err',
      seed_len: seedHex.length,
      dur_ms: Date.now() - startedAt,
      err: 'invalid_seed_hex',
    });
    return NextResponse.json(
      { error: 'seed_hex must be 64 hex chars (32 bytes)' },
      { status: 400 },
    );
  }

  // Fingerprint only (sha256, first 8 hex of the RAW seed bytes) — never the seed value.
  const seedFp = fp(seedHex);

  let sessionToken: string | null;
  try {
    sessionToken = await readMcpSessionToken();
  } catch (error) {
    logOp('dashboard.identity_back_push', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      token_present: false,
      seed_fp: seedFp,
      dur_ms: Date.now() - startedAt,
      err: (error as Error).message,
    });
    return NextResponse.json(
      { error: `Failed to read MCP session token: ${(error as Error).message}` },
      { status: 500 },
    );
  }

  if (!sessionToken) {
    logOp('dashboard.identity_back_push', 'warn', {
      trace,
      phase: 'outcome',
      status: 'err',
      token_present: false,
      seed_fp: seedFp,
      dur_ms: Date.now() - startedAt,
      err: 'mcp_offline',
    });
    return NextResponse.json(
      { error: MCP_OFFLINE_ERROR, code: MCP_OFFLINE_CODE, remediation: MCP_OFFLINE_REMEDIATION },
      { status: 503 },
    );
  }

  const adoptUrl = new URL('/v1/identity/adopt', getMcpHttpUrl()).toString();

  let response: Response;
  try {
    response = await fetch(adoptUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        [TRACE_HEADER]: trace,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seed_hex: seedHex }),
    });
  } catch (error) {
    logOp('dashboard.identity_back_push', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      token_present: true,
      seed_fp: seedFp,
      proxy_target: adoptUrl,
      dur_ms: Date.now() - startedAt,
      err: (error as Error).message,
    });
    return NextResponse.json({ error: 'local WeVibe MCP unreachable' }, { status: 503 });
  }

  const responseBody = (await response.json().catch(() => null)) as unknown;
  logOp('dashboard.identity_back_push', response.status >= 400 ? 'warn' : 'info', {
    trace,
    phase: 'outcome',
    status: response.status >= 400 ? 'err' : 'ok',
    token_present: true,
    seed_fp: seedFp,
    proxy_target: adoptUrl,
    upstream_status: response.status,
    dur_ms: Date.now() - startedAt,
  });

  if (!response.ok) {
    const upstreamError =
      isRecord(responseBody) && typeof responseBody.error === 'string'
        ? responseBody.error
        : 'Failed to adopt identity on local WeVibe MCP.';
    const upstreamCode =
      isRecord(responseBody) && typeof responseBody.code === 'string'
        ? responseBody.code
        : undefined;

    return NextResponse.json(
      upstreamCode !== undefined
        ? { error: upstreamError, code: upstreamCode }
        : { error: upstreamError },
      { status: response.status },
    );
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
