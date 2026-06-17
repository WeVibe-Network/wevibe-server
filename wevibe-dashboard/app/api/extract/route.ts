import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getMcpHttpUrl, readConfigFromEnv } from '@/lib/config';
import { MCP_OFFLINE_CODE, MCP_OFFLINE_ERROR, MCP_OFFLINE_REMEDIATION } from '@/lib/mcp-errors';
import { getCertifiedReadiness } from '@/lib/provider-readiness';
import { loadSettings } from '@/lib/settings';
import type {
  ClassifiedKeyword,
  MemoryCandidate,
  MemoryCandidateKeywords,
  SuggestedKeyword,
} from '@/lib/session-types';

export const dynamic = 'force-dynamic';
const DEFAULT_EXTRACTION_NUM_CTX = 32768;
const MCP_SESSION_TOKEN_PATH = path.join(
  homedir(),
  '.wevibe',
  'mcp-session-token',
);
const LAST_EXTRACTION_ERROR_PATH = path.join(
  homedir(),
  '.wevibe',
  'last-extraction-error.json',
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
  presetId: string | null;
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

async function recordExtractionError(stage: string, status: number, message: string): Promise<void> {
  try {
    await writeFile(
      LAST_EXTRACTION_ERROR_PATH,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          stage,
          status,
          message,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // best-effort observability only
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emptyKeywords(): MemoryCandidateKeywords {
  return {
    classified: [],
    suggestions: [],
  };
}

function isClassifiedKeyword(value: unknown): value is ClassifiedKeyword {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.keyword === 'string'
    && typeof value.weight === 'number'
    && Number.isFinite(value.weight)
  );
}

function isSuggestedKeyword(value: unknown): value is SuggestedKeyword {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.keyword === 'string'
    && typeof value.weight === 'number'
    && Number.isFinite(value.weight)
    && typeof value.rationale === 'string'
  );
}

function normalizeKeywords(value: unknown): MemoryCandidateKeywords {
  if (!isRecord(value)) {
    return emptyKeywords();
  }

  const { classified, suggestions } = value;
  if (!Array.isArray(classified) || !Array.isArray(suggestions)) {
    return emptyKeywords();
  }

  if (!classified.every(isClassifiedKeyword) || !suggestions.every(isSuggestedKeyword)) {
    return emptyKeywords();
  }

  return {
    classified: classified.map((entry) => ({
      keyword: entry.keyword,
      weight: entry.weight,
    })),
    suggestions: suggestions.map((entry) => ({
      keyword: entry.keyword,
      weight: entry.weight,
      rationale: entry.rationale,
    })),
  };
}

function normalizeMemoryCandidate(value: unknown): MemoryCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const {
    implement,
    context,
    dnd,
    stack,
    memory_type: memoryType,
    preference_confidence: preferenceConfidence,
    extraction_hash: extractionHash,
  } = value;

  if (typeof implement !== 'string' || typeof context !== 'string') {
    return null;
  }

  if (dnd !== null && typeof dnd !== 'string') {
    return null;
  }

  if (!Array.isArray(stack) || !stack.every((entry) => typeof entry === 'string')) {
    return null;
  }

  if (memoryType !== 'memory') {
    return null;
  }

  if (typeof preferenceConfidence !== 'number' || !Number.isFinite(preferenceConfidence)) {
    return null;
  }

  if (typeof extractionHash !== 'string') {
    return null;
  }

  return {
    implement,
    context,
    dnd,
    stack: [...stack],
    memory_type: memoryType,
    preference_confidence: preferenceConfidence,
    extraction_hash: extractionHash,
    keywords: normalizeKeywords(value.keywords),
  };
}

function resolveServerHubBaseUrl(): string {
  const explicitHubUrl = process.env.WEVIBE_HUB_URL?.trim();
  if (explicitHubUrl && explicitHubUrl.length > 0) {
    return explicitHubUrl.replace(/\/+$/, '');
  }

  const configuredHubUrl = readConfigFromEnv().hubUrl.trim();
  if (configuredHubUrl.length > 0) {
    return configuredHubUrl.replace(/\/+$/, '');
  }

  return 'http://localhost:4440';
}

async function fetchOrgExtractionProfileOverrides(
  orgId: string,
): Promise<ExtractionProfileOverrides | null> {
  const trimmedOrgId = orgId.trim();
  if (trimmedOrgId.length === 0) {
    return null;
  }

  const hubUrl = resolveServerHubBaseUrl();
  const profileUrl = `${hubUrl}/v1/orgs/${encodeURIComponent(trimmedOrgId)}/extraction-profile`;
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
    if (!isRecord(responseBody) || responseBody.found !== true) {
      return null;
    }

    const overrides: ExtractionProfileOverrides = {
      presetId: null,
    };

    if (typeof responseBody.system_prompt === 'string') {
      const prompt = responseBody.system_prompt.trim();
      if (prompt.length > 0) {
        overrides.prompt = prompt;
      }
    }

    if (
      typeof responseBody.num_ctx === 'number'
      && Number.isFinite(responseBody.num_ctx)
      && responseBody.num_ctx > 0
    ) {
      overrides.numCtx = responseBody.num_ctx;
    }

    if (typeof responseBody.model === 'string') {
      const model = responseBody.model.trim();
      if (model.length > 0) {
        overrides.model = model;
      }
    }

    if (typeof responseBody.preset_id === 'string') {
      const presetId = responseBody.preset_id.trim();
      if (presetId.length > 0) {
        overrides.presetId = presetId;
      }
    }

    return overrides;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function computePromptFingerprint(prompt: string | undefined): string {
  if (typeof prompt !== 'string') {
    return 'wevibe-default';
  }

  return createHash('sha256').update(prompt).digest('hex').slice(0, 12);
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
      { error: MCP_OFFLINE_ERROR, code: MCP_OFFLINE_CODE, remediation: MCP_OFFLINE_REMEDIATION },
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
  const readiness = await getCertifiedReadiness(settings);
  if (!readiness.ready) {
    return NextResponse.json(
      { error: readiness.reason ?? 'Extraction model is not available.', code: 'provider_not_configured' },
      { status: 422 },
    );
  }

  const activeOrgId = settings.org_id.trim();
  const profileOverrides = await fetchOrgExtractionProfileOverrides(activeOrgId);
  const useLmStudio = settings.llm_provider === 'lm_studio';
  const modelFromSettings = useLmStudio
    ? settings.lmstudio_model.trim()
    : settings.ollama_model.trim();
  const resolvedLocalModel = profileOverrides?.model ?? modelFromSettings;
  const openRouterModel = settings.openrouter_model.trim();
  const useOpenRouter =
    settings.llm_provider === 'openrouter'
    && openRouterModel.length > 0;
  const resolvedModel = useOpenRouter ? openRouterModel : resolvedLocalModel;
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
    provider?: string;
    api_key?: string;
    base_url?: string;
    org_id?: string;
  } = {
    transcript: body.transcript,
    project_context: projectContext,
  };

  if (activeOrgId.length > 0) {
    mcpExtractRequestBody.org_id = activeOrgId;
  }

  if (profileOverrides?.prompt) {
    mcpExtractRequestBody.prompt = profileOverrides.prompt;
  }

  if (profileOverrides?.numCtx && profileOverrides.numCtx > 0) {
    mcpExtractRequestBody.num_ctx = profileOverrides.numCtx;
  }

  if (resolvedModel.length > 0) {
    mcpExtractRequestBody.model = resolvedModel;
  }

  if (useOpenRouter) {
    mcpExtractRequestBody.provider = 'openrouter';
    mcpExtractRequestBody.api_key = settings.extraction_api_key;
    mcpExtractRequestBody.base_url = 'https://openrouter.ai/api/v1';
  } else if (useLmStudio) {
    mcpExtractRequestBody.provider = 'lm_studio';
    mcpExtractRequestBody.api_key = 'lm-studio';
    mcpExtractRequestBody.base_url = settings.lmstudio_url;
  } else if (settings.ollama_url.trim().length > 0) {
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

    await recordExtractionError('mcp_error', response.status, errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: response.status });
  }

  const mcpEmptyReason =
    isRecord(responseBody) && isRecord(responseBody.meta) && typeof responseBody.meta.emptyReason === 'string'
      ? responseBody.meta.emptyReason
      : undefined;

  if (!isRecord(responseBody) || !Array.isArray(responseBody.memories)) {
    await recordExtractionError(
      'invalid_payload',
      502,
      'MCP extraction returned invalid memory payload',
    );
    return NextResponse.json(
      { error: 'MCP extraction returned invalid memory payload' },
      { status: 502 },
    );
  }

  const memories = responseBody.memories;
  const normalizedMemories: MemoryCandidate[] = [];
  for (const memory of memories) {
    const normalizedMemory = normalizeMemoryCandidate(memory);
    if (!normalizedMemory) {
      await recordExtractionError(
        'invalid_payload',
        502,
        'MCP extraction returned invalid memory payload',
      );
      return NextResponse.json(
        { error: 'MCP extraction returned invalid memory payload' },
        { status: 502 },
      );
    }
    normalizedMemories.push(normalizedMemory);
  }

  return NextResponse.json({
    memories: normalizedMemories,
    extraction_meta: {
      source: profileOverrides ? 'org-profile' : 'wevibe-default',
      preset_id: profileOverrides?.presetId ?? null,
      model: resolvedModel,
      provider: useOpenRouter ? 'openrouter' : useLmStudio ? 'lm_studio' : 'ollama',
      is_local: !useOpenRouter,
      num_ctx: mcpExtractRequestBody.num_ctx ?? DEFAULT_EXTRACTION_NUM_CTX,
      prompt_fingerprint: computePromptFingerprint(mcpExtractRequestBody.prompt),
      ...(normalizedMemories.length === 0
        ? { empty_reason: mcpEmptyReason ?? 'no_durable_memories' }
        : {}),
    },
  });
}
