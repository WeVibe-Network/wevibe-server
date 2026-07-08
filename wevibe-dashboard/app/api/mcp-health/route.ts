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

export async function GET(request: NextRequest) {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();
  logOp('dashboard.mcp_health', 'info', { trace, phase: 'entry', method: 'GET' });

  let sessionToken: string | null = null;
  try {
    sessionToken = await readMcpSessionToken();
  } catch (error) {
    logOp('dashboard.mcp_health', 'warn', {
      trace,
      phase: 'token',
      status: 'warn',
      err: (error as Error).message,
    });
  }

  const healthUrl = new URL('/v1/health', getMcpHttpUrl()).toString();
  const headers: Record<string, string> = { [TRACE_HEADER]: trace };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetch(healthUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    logOp('dashboard.mcp_health', 'warn', {
      trace,
      phase: 'outcome',
      outcome: 'down',
      status: 'down',
      proxy_target: healthUrl,
      dur_ms: Date.now() - startedAt,
      token_present: Boolean(sessionToken),
      err: (error as Error).message,
    });
    return NextResponse.json({ alive: false }, { status: 200 });
  } finally {
    clearTimeout(timeoutId);
  }

  logOp('dashboard.mcp_health', 'info', {
    trace,
    phase: 'outcome',
    outcome: 'alive',
    status: 'alive',
    proxy_target: healthUrl,
    upstream_status: response.status,
    dur_ms: Date.now() - startedAt,
    token_present: Boolean(sessionToken),
  });
  return NextResponse.json({ alive: true, status: response.status }, { status: 200 });
}
