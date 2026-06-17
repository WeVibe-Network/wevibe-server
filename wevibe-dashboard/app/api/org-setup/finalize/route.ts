import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl } from '@/lib/config';
import { getDeploymentMode } from '@/lib/deployment';
import {
  MCP_OFFLINE_CODE,
  MCP_OFFLINE_ERROR,
  MCP_OFFLINE_REMEDIATION,
  ORG_LOCAL_ONLY_CODE,
  ORG_LOCAL_ONLY_ERROR,
  ORG_LOCAL_ONLY_REMEDIATION,
} from '@/lib/mcp-errors';

export const dynamic = 'force-dynamic';

const MCP_SESSION_TOKEN_PATH = path.join(
  homedir(),
  '.wevibe',
  'mcp-session-token',
);

interface OrgSetupFinalizeRequestBody {
  setup_id: string;
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
  if (getDeploymentMode() === 'server') {
    return NextResponse.json(
      { error: ORG_LOCAL_ONLY_ERROR, code: ORG_LOCAL_ONLY_CODE, remediation: ORG_LOCAL_ONLY_REMEDIATION },
      { status: 422 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  if (!isRecord(rawBody)) {
    return NextResponse.json({ error: 'setup_id and org_id are required' }, { status: 400 });
  }

  const { setup_id: setupId, org_id: orgId } = rawBody;
  if (!isNonEmptyString(setupId) || !isNonEmptyString(orgId)) {
    return NextResponse.json({ error: 'setup_id and org_id are required' }, { status: 400 });
  }

  const body: OrgSetupFinalizeRequestBody = {
    setup_id: setupId.trim(),
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
      { error: MCP_OFFLINE_ERROR, code: MCP_OFFLINE_CODE, remediation: MCP_OFFLINE_REMEDIATION },
      { status: 503 },
    );
  }

  const mcpHttpUrl = getMcpHttpUrl();
  const orgSetupFinalizeUrl = new URL('/v1/org-setup/finalize', mcpHttpUrl).toString();

  let response: Response;
  try {
    response = await fetch(orgSetupFinalizeUrl, {
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
