import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MCP_SESSION_TOKEN_PATH = path.join(homedir(), '.wevibe', 'mcp-session-token');

async function readMcpSessionToken(): Promise<string | null> {
  try {
    const token = (await readFile(MCP_SESSION_TOKEN_PATH, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const op = 'dashboard.mcp_mod_embed_card';
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();
  logOp(op, 'info', { trace, phase: 'entry', method: 'POST' });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logOp(op, 'warn', { trace, phase: 'body', status: 'warn' });
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  let sessionToken: string | null = null;
  try {
    sessionToken = await readMcpSessionToken();
  } catch (error) {
    logOp(op, 'warn', {
      trace,
      phase: 'token',
      status: 'warn',
      err: (error as Error).message,
    });
  }

  const proxyTarget = new URL('/v1/mod/embed-retrieval-card', getMcpHttpUrl()).toString();
  const headers: Record<string, string> = { [TRACE_HEADER]: trace };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(proxyTarget, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    logOp(op, 'info', {
      trace,
      phase: 'outcome',
      status: 'ok',
      proxy_target: proxyTarget,
      upstream_status: response.status,
      dur_ms: Date.now() - startedAt,
      token_present: Boolean(sessionToken),
    });
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    logOp(op, 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      proxy_target: proxyTarget,
      dur_ms: Date.now() - startedAt,
      token_present: Boolean(sessionToken),
      err: (error as Error).message,
    });
    return NextResponse.json({ error: 'mcp unreachable' }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
