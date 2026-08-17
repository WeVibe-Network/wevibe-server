import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MCP_SESSION_TOKEN_PATH = path.join(homedir(), '.wevibe', 'mcp-session-token');

function wevibeDir(): string {
  const override = process.env.WEVIBE_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), '.wevibe');
}

async function readMcpSessionToken(): Promise<string | null> {
  try {
    const token = (await readFile(MCP_SESSION_TOKEN_PATH, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Which identity is the serving MCP holding?
 *
 * Read from the non-secret identity sidecar, which exists precisely so identity
 * can be reported WITHOUT triggering a biometric prompt. Callers compare this to
 * the browser's own pubkey: equal means org-setup will succeed, different means
 * it would 409 (or, unguarded, mint an org the browser can never see). Liveness
 * alone cannot surface that — a healthy MCP serving the WRONG identity looks
 * identical to a correct one until the request fails.
 */
async function readMcpIdentityPubkey(): Promise<string | null> {
  try {
    const raw = await readFile(path.join(wevibeDir(), 'identity.json'), 'utf8');
    const parsed = JSON.parse(raw) as { ed25519PublicKey?: unknown };
    return typeof parsed.ed25519PublicKey === 'string' && parsed.ed25519PublicKey.length > 0
      ? parsed.ed25519PublicKey
      : null;
  } catch {
    // Missing/unreadable/malformed sidecar is not a health failure — the MCP may
    // be alive and simply not yet provisioned. Report null and let callers decide.
    return null;
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

  const mcpPubkey = await readMcpIdentityPubkey();

  logOp('dashboard.mcp_health', 'info', {
    trace,
    phase: 'outcome',
    outcome: 'alive',
    status: 'alive',
    proxy_target: healthUrl,
    upstream_status: response.status,
    dur_ms: Date.now() - startedAt,
    token_present: Boolean(sessionToken),
    mcp_pubkey_fp: mcpPubkey ? mcpPubkey.slice(0, 8) : '-',
  });
  return NextResponse.json(
    { alive: true, status: response.status, mcpPubkey },
    { status: 200 },
  );
}
