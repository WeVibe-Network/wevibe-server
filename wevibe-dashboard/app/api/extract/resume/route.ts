import { NextRequest, NextResponse } from 'next/server';

import { getMcpHttpUrl } from '@/lib/config';
import { isRecord, readMcpSessionToken } from '@/lib/extract-shared';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';
import { MCP_OFFLINE_CODE, MCP_OFFLINE_ERROR, MCP_OFFLINE_REMEDIATION } from '@/lib/mcp-errors';
import { loadSettings, ORCAROUTER_BASE_URL } from '@/lib/settings';
import { resolveExtractionProvider, resolveSessionModel } from '@/lib/session-model';

export const dynamic = 'force-dynamic';
const MCP_RESUME_TIMEOUT_MS = 30_000;

interface ExtractResumeRequestBody {
  job_id?: string;
  model?: string;
  session_id?: string;
  session_model?: string;
}

interface McpExtractResumeRequestBody {
  job_id: string;
  model: string;
  provider: 'ollama' | 'openrouter' | 'lm_studio' | 'orcarouter';
  api_key?: string;
  base_url?: string;
  ollama_url?: string;
}

function fullErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (error) {
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'invalid_json',
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: 'request body must be valid JSON', code: 'invalid_json' },
        { status: 400 },
      );
    }

    const body = (isRecord(rawBody) ? rawBody : {}) as ExtractResumeRequestBody;
    const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
    const chosenModel = typeof body.model === 'string' ? body.model.trim() : '';
    const sessionModel = typeof body.session_model === 'string' ? body.session_model : '';

    if (jobId.length === 0) {
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'validation',
        err: 'job_id is required',
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: 'job_id is required', code: 'job_id_required' },
        { status: 400 },
      );
    }

    if (chosenModel.length === 0) {
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        reason: 'validation',
        err: 'model is required',
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: 'model is required', code: 'model_required' },
        { status: 400 },
      );
    }

    const settings = loadSettings();
    const extractionProvider = resolveExtractionProvider(
      resolveSessionModel(sessionModel).providerID,
      settings.llm_provider,
    );
    const useOrcarouter = extractionProvider === 'orcarouter';
    const useOpenRouter = extractionProvider === 'openrouter';
    const useLmStudio = extractionProvider === 'lm_studio';
    const provider: 'ollama' | 'openrouter' | 'lm_studio' | 'orcarouter' =
      useOrcarouter ? 'orcarouter' : useOpenRouter ? 'openrouter' : useLmStudio ? 'lm_studio' : 'ollama';
    const isLocal = !useOrcarouter && !useOpenRouter;

    logOp('dashboard.extract_resume', 'info', {
      trace,
      phase: 'entry',
      method: 'POST',
      job_id: jobId,
      model: chosenModel,
      session_model_present: sessionModel.length > 0,
      provider,
      is_local: isLocal,
    });

    let sessionToken: string | null;
    try {
      sessionToken = await readMcpSessionToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        reason: 'token_read',
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: `Failed to read MCP session token: ${message}` },
        { status: 500 },
      );
    }

    if (!sessionToken) {
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        reason: 'session_token_missing',
        has_session_token: false,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          error: MCP_OFFLINE_ERROR,
          code: MCP_OFFLINE_CODE,
          remediation: MCP_OFFLINE_REMEDIATION,
        },
        { status: 503 },
      );
    }

    const mcpHttpUrl = getMcpHttpUrl();
    const resumeUrl = new URL('/v1/extract/resume', mcpHttpUrl).toString();

    const mcpResumeRequestBody: McpExtractResumeRequestBody = {
      job_id: jobId,
      model: chosenModel,
      provider,
    };

    if (useOrcarouter) {
      mcpResumeRequestBody.base_url = ORCAROUTER_BASE_URL;
    } else if (useOpenRouter) {
      mcpResumeRequestBody.api_key = settings.extraction_api_key;
      mcpResumeRequestBody.base_url = 'https://openrouter.ai/api/v1';
    } else if (useLmStudio) {
      mcpResumeRequestBody.api_key = 'lm-studio';
      mcpResumeRequestBody.base_url = settings.lmstudio_url;
    } else if (settings.ollama_url.trim().length > 0) {
      mcpResumeRequestBody.ollama_url = settings.ollama_url;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), MCP_RESUME_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(resumeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          [TRACE_HEADER]: trace,
        },
        signal: controller.signal,
        body: JSON.stringify(mcpResumeRequestBody),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logOp('dashboard.extract_resume', 'error', {
          trace,
          phase: 'outcome',
          status: 'err',
          job_id: jobId,
          proxy_target: resumeUrl,
          reason: 'timeout',
          err: 'extraction_resume_timeout',
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json(
          {
            error: 'extraction resume request timed out — local WeVibe MCP did not respond',
            code: 'extraction_resume_timeout',
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
        logOp('dashboard.extract_resume', 'error', {
          trace,
          phase: 'outcome',
          status: 'err',
          job_id: jobId,
          proxy_target: resumeUrl,
          reason: 'connection',
          err: code,
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json(
          { error: `local WeVibe MCP unreachable at ${mcpHttpUrl}` },
          { status: 503 },
        );
      }

      const message = error instanceof Error ? error.message : String(error);
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        proxy_target: resumeUrl,
        reason: 'network',
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: `extraction resume request to local WeVibe MCP failed: ${message}` },
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
        isRecord(responseBody) && typeof responseBody.error === 'string' && responseBody.error.trim().length > 0
          ? responseBody.error
          : `MCP extraction resume failed with status ${response.status}`;

      logOp('dashboard.extract_resume', 'warn', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        proxy_target: resumeUrl,
        upstream_status: response.status,
        err: errorMessage,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: errorMessage }, { status: response.status });
    }

    const resumedJobId =
      isRecord(responseBody) && typeof responseBody.job_id === 'string'
        ? responseBody.job_id
        : null;
    if (!resumedJobId) {
      const message = 'MCP extraction resume did not return a job id';
      logOp('dashboard.extract_resume', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        proxy_target: resumeUrl,
        upstream_status: response.status,
        reason: 'invalid_payload',
        err: message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: message }, { status: 502 });
    }

    logOp('dashboard.extract_resume', 'info', {
      trace,
      phase: 'outcome',
      status: 'ok',
      job_id: resumedJobId,
      model: chosenModel,
      provider,
      is_local: isLocal,
      proxy_target: resumeUrl,
      upstream_status: response.status,
      dur_ms: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        job_id: resumedJobId,
        extraction_meta: {
          model: chosenModel,
          session_model: sessionModel,
          provider,
          is_local: isLocal,
        },
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOp('dashboard.extract_resume', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      err: fullErrorText(error),
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
