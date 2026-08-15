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

interface OrgSetupRequestBody {
  org_name: string;
  domain: string;
  leader_wallet?: string;
  requester_pubkey: string;
  requester_x25519_pubkey: string;
  signature: string;
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
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  if (!isRecord(rawBody)) {
    return NextResponse.json({ error: 'org_name and domain are required' }, { status: 400 });
  }

  const {
    org_name: orgName,
    domain,
    leader_wallet: leaderWallet,
    requester_pubkey: requesterPubkey,
    requester_x25519_pubkey: requesterX25519Pubkey,
    signature,
  } = rawBody;
  if (!isNonEmptyString(orgName) || !isNonEmptyString(domain)) {
    return NextResponse.json({ error: 'org_name and domain are required' }, { status: 400 });
  }

  if (leaderWallet !== undefined && typeof leaderWallet !== 'string') {
    return NextResponse.json({ error: 'leader_wallet must be a string' }, { status: 400 });
  }

  if (
    !isNonEmptyString(requesterPubkey)
    || !isNonEmptyString(requesterX25519Pubkey)
    || !isNonEmptyString(signature)
  ) {
    return NextResponse.json(
      { error: 'requester_pubkey, requester_x25519_pubkey, and signature are required' },
      { status: 400 },
    );
  }

  const body: OrgSetupRequestBody = {
    org_name: orgName.trim(),
    domain: domain.trim(),
    ...(typeof leaderWallet === 'string' ? { leader_wallet: leaderWallet } : {}),
    requester_pubkey: requesterPubkey,
    requester_x25519_pubkey: requesterX25519Pubkey,
    signature,
  };

  logOp('dashboard.org_setup', 'info', {
    trace,
    phase: 'entry',
    method: 'POST',
    org_name_len: body.org_name.length,
    domain_len: body.domain.length,
    leader_wallet_present:
      typeof body.leader_wallet === 'string' && body.leader_wallet.length > 0,
  });

  let sessionToken: string | null;
  try {
    sessionToken = await readMcpSessionToken();
  } catch (error) {
    logOp('dashboard.org_setup', 'error', {
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

  const mcpHttpUrl = getMcpHttpUrl();
  const orgSetupUrl = new URL('/v1/org-setup', mcpHttpUrl).toString();

  let response: Response;
  try {
    response = await fetch(orgSetupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        [TRACE_HEADER]: trace,
      },
      body: JSON.stringify(body),
    });
  } catch {
    logOp('dashboard.org_setup', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      proxy_target: orgSetupUrl,
      dur_ms: Date.now() - startedAt,
      err: 'mcp_unreachable',
    });
    return NextResponse.json({ error: 'local WeVibe MCP unreachable' }, { status: 503 });
  }

  const responseBody = (await response.json()) as unknown;
  logOp('dashboard.org_setup', response.status >= 400 ? 'warn' : 'info', {
    trace,
    phase: 'outcome',
    status: response.status >= 400 ? 'err' : 'ok',
    proxy_target: orgSetupUrl,
    upstream_status: response.status,
    dur_ms: Date.now() - startedAt,
    token_present: Boolean(sessionToken),
  });
  return NextResponse.json(responseBody, { status: response.status });
}
