import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getMcpHttpUrl, readConfigFromEnv } from '@/lib/config';
import { readMcpSessionToken, recordExtractionError, isRecord } from '@/lib/extract-shared';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';
import { MCP_OFFLINE_CODE, MCP_OFFLINE_ERROR, MCP_OFFLINE_REMEDIATION } from '@/lib/mcp-errors';
import { getCertifiedReadiness } from '@/lib/provider-readiness';
import { loadSettings, ORCAROUTER_BASE_URL } from '@/lib/settings';
import { resolveExtractionProvider, resolveSessionModel } from '@/lib/session-model';
import { getDbPath, getSessionTitle } from '@/lib/opencode-session-events';

export const dynamic = 'force-dynamic';
const DEFAULT_EXTRACTION_NUM_CTX = 32768;
const MCP_ENQUEUE_TIMEOUT_MS = 30_000; // the enqueue POST returns fast (202 {job_id}); no long-held connection
const BENCH_SESSION_TITLE_PATTERN = /^wevibe-bench-(.+)-(on|off)-(\d+)$/;

interface ExtractRequestBody {
  title?: string;
  directory?: string;
  model?: string;
  stack?: string[];
  org_id?: string;
  session_id: string;
}

interface ExtractionProfileOverrides {
  prompt?: string;
  numCtx?: number;
  presetId: string | null;
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
  trace: string,
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
      headers: {
        [TRACE_HEADER]: trace,
      },
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
  const body = (await request.json()) as Partial<ExtractRequestBody>;
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();
  const activeOrgId = (body.org_id ?? '').trim();
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';

  const sessionDbPath = getDbPath();

  logOp('dashboard.extract', 'info', {
    trace,
    phase: 'entry',
    method: 'POST',
    has_title: Boolean(body.title),
    has_stack: Array.isArray(body.stack),
    has_session_id: sessionId.length > 0,
    org: activeOrgId || '-',
    session_db_path_len: sessionDbPath.length,
  });

  if (sessionId.length === 0) {
    logOp('dashboard.extract', 'warn', {
      trace,
      phase: 'outcome',
      status: 'err',
      org: activeOrgId || '-',
      err: 'session_id_required',
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'session_id is required', code: 'session_id_required' },
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

  const bodyTitle = typeof body.title === 'string' ? body.title.trim() : '';
  let sessionTitle = bodyTitle;
  if (sessionTitle.length === 0) {
    try {
      sessionTitle = getSessionTitle(sessionId);
    } catch (error) {
      logOp('dashboard.extract', 'warn', {
        trace,
        phase: 'session_title_lookup',
        org: activeOrgId || '-',
        session_id: sessionId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const projectContext: {
    title: string;
    directory: string;
    stack?: string[];
  } = {
    title: sessionTitle.length > 0 ? sessionTitle : 'unknown',
    directory: body.directory ?? 'unknown',
  };

  if (Array.isArray(body.stack) && body.stack.every((entry) => typeof entry === 'string')) {
    projectContext.stack = body.stack;
  }

  const settings = loadSettings();
  const sessionModel = typeof body.model === 'string' ? body.model.trim() : '';
  const overrideModel = settings.extraction_model_override.trim();
  const resolvedSessionModel = resolveSessionModel(sessionModel);
  const effectiveModel =
    settings.extraction_override_enabled && overrideModel.length > 0
      ? overrideModel
      : resolvedSessionModel.slug;
  if (effectiveModel.length === 0) {
    return NextResponse.json(
      {
        error: 'extraction model not configured — set it in Settings',
        code: 'extraction_model_not_configured',
      },
      { status: 400 },
    );
  }

  const extractionProvider = resolveExtractionProvider(
    resolvedSessionModel.providerID,
    settings.llm_provider,
  );
  const useOrcarouter = extractionProvider === 'orcarouter';
  const useOpenRouter = extractionProvider === 'openrouter';
  const useLmStudio = extractionProvider === 'lm_studio';

  if (!useOrcarouter) {
    const readiness = await getCertifiedReadiness(settings, effectiveModel);
    if (!readiness.ready) {
      return NextResponse.json(
        { error: readiness.reason ?? 'Extraction model is not available.', code: 'provider_not_configured' },
        { status: 422 },
      );
    }
  }

  const profileOverrides = await fetchOrgExtractionProfileOverrides(activeOrgId, trace);
  const mcpExtractRequestBody: {
    session_db_path: string;
    project_context: {
      title: string;
      directory: string;
      stack?: string[];
    };
    model: string;
    prompt?: string;
    num_ctx?: number;
    ollama_url?: string;
    provider?: string;
    api_key?: string;
    base_url?: string;
    org_id?: string;
    session_id: string;
  } = {
    session_db_path: sessionDbPath,
    project_context: projectContext,
    model: effectiveModel,
    session_id: sessionId,
  };

  if (activeOrgId.length > 0) {
    mcpExtractRequestBody.org_id = activeOrgId;
  } else {
    const benchTitleMatch = BENCH_SESSION_TITLE_PATTERN.exec(sessionTitle);
    if (benchTitleMatch) {
      const derivedOrgId = benchTitleMatch[1].trim();
      if (derivedOrgId.length > 0) {
        mcpExtractRequestBody.org_id = derivedOrgId;
      }
    }
  }

  if (profileOverrides?.prompt) {
    mcpExtractRequestBody.prompt = profileOverrides.prompt;
  }

  if (profileOverrides?.numCtx && profileOverrides.numCtx > 0) {
    mcpExtractRequestBody.num_ctx = profileOverrides.numCtx;
  }

  if (useOrcarouter) {
    mcpExtractRequestBody.provider = 'orcarouter';
    mcpExtractRequestBody.base_url = ORCAROUTER_BASE_URL;
  } else if (useOpenRouter) {
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

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), MCP_ENQUEUE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(extractUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        [TRACE_HEADER]: trace,
      },
      signal: controller.signal,
      body: JSON.stringify(mcpExtractRequestBody),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logOp('dashboard.extract', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        org: activeOrgId || '-',
        proxy_target: extractUrl,
        dur_ms: Date.now() - startedAt,
        err: 'enqueue_timeout',
        reason: 'timeout',
      });
      return NextResponse.json(
        {
          error: 'enqueueing extraction timed out — local WeVibe MCP did not respond',
          code: 'extraction_enqueue_timeout',
        },
        { status: 504 },
      );
    }

    const code = (error as { cause?: { code?: string } })?.cause?.code
      ?? (error as { code?: string })?.code;
    if (
      code === 'ECONNREFUSED'
      || code === 'ECONNRESET'
      || code === 'EAI_AGAIN'
      || code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      logOp('dashboard.extract', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        org: activeOrgId || '-',
        proxy_target: extractUrl,
        dur_ms: Date.now() - startedAt,
        err: code,
        reason: 'connection',
      });
      return NextResponse.json(
        { error: `local WeVibe MCP unreachable at ${mcpHttpUrl}` },
        { status: 503 },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    logOp('dashboard.extract', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      org: activeOrgId || '-',
      proxy_target: extractUrl,
      dur_ms: Date.now() - startedAt,
      err: message,
      reason: 'network',
    });
    return NextResponse.json(
      { error: `extraction request to local WeVibe MCP failed: ${message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeoutHandle);
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
    logOp('dashboard.extract', 'warn', {
      trace,
      phase: 'outcome',
      status: 'err',
      org: activeOrgId || '-',
      proxy_target: extractUrl,
      upstream_status: response.status,
      dur_ms: Date.now() - startedAt,
      err: errorMessage,
    });
    return NextResponse.json({ error: errorMessage }, { status: response.status });
  }

  const jobId = isRecord(responseBody) && typeof responseBody.job_id === 'string' ? responseBody.job_id : null;
  if (!jobId) {
    await recordExtractionError('invalid_enqueue', 502, 'MCP did not return a job_id');
    logOp('dashboard.extract', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      org: activeOrgId || '-',
      proxy_target: extractUrl,
      upstream_status: response.status,
      dur_ms: Date.now() - startedAt,
      err: 'invalid_enqueue',
    });
    return NextResponse.json({ error: 'MCP extraction did not return a job id' }, { status: 502 });
  }

  logOp('dashboard.extract', 'info', {
    trace,
    phase: 'outcome',
    status: 'ok',
    org: activeOrgId || '-',
    proxy_target: extractUrl,
    upstream_status: response.status,
    dur_ms: Date.now() - startedAt,
    job_id: jobId,
  });

  return NextResponse.json({
    job_id: jobId,
    extraction_meta: {
      source: profileOverrides ? 'org-profile' : 'wevibe-default',
      preset_id: profileOverrides?.presetId ?? null,
      model: effectiveModel,
      session_model: sessionModel,
      provider: useOrcarouter ? 'orcarouter' : useOpenRouter ? 'openrouter' : useLmStudio ? 'lm_studio' : 'ollama',
      is_local: useOrcarouter ? false : !useOpenRouter,
      num_ctx: mcpExtractRequestBody.num_ctx ?? DEFAULT_EXTRACTION_NUM_CTX,
      prompt_fingerprint: computePromptFingerprint(mcpExtractRequestBody.prompt),
    },
  }, { status: 202 });
}
