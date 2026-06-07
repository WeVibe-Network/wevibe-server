import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl, readConfigFromEnv } from '@/lib/config';
import { loadSettings } from '@/lib/settings';
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

interface ExtractionProfileOverrides {
  prompt?: string;
  numCtx?: number;
  model?: string;
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
    typeof value.implement === 'string'
    && typeof value.context === 'string'
    && (value.dnd === null || typeof value.dnd === 'string')
    && Array.isArray(value.stack)
    && value.stack.every((entry) => typeof entry === 'string')
    && value.memory_type === 'memory'
    && typeof value.preference_confidence === 'number'
    && Number.isFinite(value.preference_confidence)
    && typeof value.extraction_hash === 'string'
  );
}

function resolveServerChainRestBaseUrl(): string {
  const explicitRestUrl = process.env.WEVIBE_CHAIN_REST_URL?.trim();
  if (explicitRestUrl && explicitRestUrl.length > 0) {
    return explicitRestUrl.replace(/\/+$/, '');
  }

  const configuredRestUrl = readConfigFromEnv().chainRest.trim();
  if (configuredRestUrl.length > 0) {
    return configuredRestUrl.replace(/\/+$/, '');
  }

  return 'http://localhost:1317';
}

async function fetchOrgExtractionProfileOverrides(
  orgId: string,
): Promise<ExtractionProfileOverrides | null> {
  const trimmedOrgId = orgId.trim();
  if (trimmedOrgId.length === 0) {
    return null;
  }

  const chainRest = resolveServerChainRestBaseUrl();
  const profileUrl = `${chainRest}/wevibe/org/v1/extraction-profile/${encodeURIComponent(trimmedOrgId)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 2500);

  try {
    const response = await fetch(profileUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const responseBody = (await response.json()) as unknown;
    if (!isRecord(responseBody) || responseBody.found !== true || !isRecord(responseBody.profile)) {
      return null;
    }

    const profile = responseBody.profile;
    const overrides: ExtractionProfileOverrides = {};

    if (typeof profile.system_prompt === 'string') {
      const prompt = profile.system_prompt.trim();
      if (prompt.length > 0) {
        overrides.prompt = prompt;
      }
    }

    if (
      typeof profile.num_ctx === 'number'
      && Number.isFinite(profile.num_ctx)
      && profile.num_ctx > 0
    ) {
      overrides.numCtx = profile.num_ctx;
    }

    if (typeof profile.extraction_model === 'string') {
      const model = profile.extraction_model.trim();
      if (model.length > 0) {
        overrides.model = model;
      }
    }

    return overrides;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
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

  const settings = loadSettings();
  const profileOverrides = await fetchOrgExtractionProfileOverrides(settings.org_id);
  const modelFromSettings = settings.ollama_model.trim();
  const resolvedModel = profileOverrides?.model ?? modelFromSettings;
  const mcpExtractRequestBody: {
    transcript: string;
    project_context: {
      title: string;
      directory: string;
      stack?: string[];
    };
    prompt?: string;
    num_ctx?: number;
    model?: string;
    ollama_url?: string;
  } = {
    transcript: body.transcript,
    project_context: projectContext,
  };

  if (profileOverrides?.prompt) {
    mcpExtractRequestBody.prompt = profileOverrides.prompt;
  }

  if (profileOverrides?.numCtx && profileOverrides.numCtx > 0) {
    mcpExtractRequestBody.num_ctx = profileOverrides.numCtx;
  }

  if (resolvedModel.length > 0) {
    mcpExtractRequestBody.model = resolvedModel;
  }

  if (settings.ollama_url.trim().length > 0) {
    mcpExtractRequestBody.ollama_url = settings.ollama_url;
  }

  let response: Response;
  try {
    response = await fetch(extractUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(mcpExtractRequestBody),
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
