import { NextResponse } from 'next/server';

import { getMcpHttpUrl } from '@/lib/config';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';
import { MCP_OFFLINE_CODE, MCP_OFFLINE_ERROR, MCP_OFFLINE_REMEDIATION } from '@/lib/mcp-errors';
import {
  isRecord,
  normalizeMemoryCandidate,
  readMcpSessionToken,
  recordExtractionError,
} from '@/lib/extract-shared';
import type { MemoryCandidate } from '@/lib/session-types';

export const dynamic = 'force-dynamic';
const MCP_STATUS_TIMEOUT_MS = 15_000;

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

function chunkCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function upstreamErrorMessage(responseBody: unknown, statusCode: number): string {
  if (isRecord(responseBody) && typeof responseBody.error === 'string' && responseBody.error.trim().length > 0) {
    return responseBody.error;
  }
  return `MCP extraction status failed with status ${statusCode}`;
}

export async function GET(request: Request): Promise<Response> {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();

  try {
    const jobId = new URL(request.url).searchParams.get('job_id')?.trim();
    if (!jobId) {
      logOp('dashboard.extract_status', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'validation',
        err: 'job_id is required',
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: 'job_id is required' }, { status: 400 });
    }

    logOp('dashboard.extract_status', 'info', {
      trace,
      phase: 'entry',
      method: 'GET',
      job_id: jobId,
    });

    let sessionToken: string | null;
    try {
      sessionToken = await readMcpSessionToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOp('dashboard.extract_status', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        reason: 'token_read',
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: `Failed to read MCP session token: ${message}` }, { status: 500 });
    }

    if (!sessionToken) {
      logOp('dashboard.extract_status', 'error', {
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
    const statusUrl = new URL(`/v1/extract/status/${encodeURIComponent(jobId)}`, mcpHttpUrl).toString();

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), MCP_STATUS_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          [TRACE_HEADER]: trace,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logOp('dashboard.extract_status', 'error', {
          trace,
          phase: 'outcome',
          status: 'err',
          job_id: jobId,
          proxy_target: statusUrl,
          reason: 'timeout',
          err: 'extraction_status_timeout',
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json(
          {
            error: 'extraction status request timed out — local WeVibe MCP did not respond',
            code: 'extraction_status_timeout',
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
        logOp('dashboard.extract_status', 'error', {
          trace,
          phase: 'outcome',
          status: 'err',
          job_id: jobId,
          proxy_target: statusUrl,
          reason: 'connection',
          err: code,
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json({ error: `local WeVibe MCP unreachable at ${mcpHttpUrl}` }, { status: 503 });
      }

      const message = error instanceof Error ? error.message : String(error);
      logOp('dashboard.extract_status', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        proxy_target: statusUrl,
        reason: 'network',
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: `extraction status request to local WeVibe MCP failed: ${message}` },
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
      if (response.status === 404) {
        logOp('dashboard.extract_status', 'error', {
          trace,
          phase: 'outcome',
          status: 'err',
          job_id: jobId,
          proxy_target: statusUrl,
          upstream_status: response.status,
          reason: 'not_found',
          err: 'extraction job not found',
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json({ error: 'extraction job not found' }, { status: 404 });
      }

      const message = upstreamErrorMessage(responseBody, response.status);
      await recordExtractionError('mcp_status_error', response.status, message);
      logOp('dashboard.extract_status', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        job_id: jobId,
        proxy_target: statusUrl,
        upstream_status: response.status,
        reason: 'upstream',
        err: message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: message }, { status: response.status });
    }

    const body = isRecord(responseBody) ? responseBody : null;
    const status = body && typeof body.status === 'string' ? body.status : null;
    const chunksDone = chunkCount(body?.chunks_done);
    const chunksTotal = chunkCount(body?.chunks_total);

    if (status === 'running') {
      logOp('dashboard.extract_status', 'info', {
        trace,
        phase: 'outcome',
        status: 'ok',
        job_id: jobId,
        proxy_target: statusUrl,
        upstream_status: response.status,
        chunks_done: chunksDone,
        chunks_total: chunksTotal,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({
        status: 'running',
        chunks_done: chunksDone,
        chunks_total: chunksTotal,
      });
    }

    if (status === 'error') {
      const message = body && typeof body.error === 'string' && body.error.trim().length > 0
        ? body.error
        : 'extraction failed';
      logOp('dashboard.extract_status', 'warn', {
        trace,
        phase: 'outcome',
        status: 'ok',
        job_id: jobId,
        proxy_target: statusUrl,
        upstream_status: response.status,
        chunks_done: chunksDone,
        chunks_total: chunksTotal,
        err: message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({
        status: 'error',
        chunks_done: chunksDone,
        chunks_total: chunksTotal,
        error: message,
      });
    }

    if (status === 'done') {
      const result = body && isRecord(body.result) ? body.result : null;
      if (!result || !Array.isArray(result.memories)) {
        const message = 'MCP extraction returned invalid memory payload';
        await recordExtractionError('invalid_payload', 502, message);
        logOp('dashboard.extract_status', 'error', {
          trace,
          phase: 'outcome',
          status: 'err',
          job_id: jobId,
          proxy_target: statusUrl,
          reason: 'invalid_payload',
          err: message,
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json({
          status: 'error',
          chunks_done: chunksDone,
          chunks_total: chunksTotal,
          error: message,
        });
      }

      const normalizedMemories: MemoryCandidate[] = [];
      for (const candidate of result.memories) {
        const normalized = normalizeMemoryCandidate(candidate);
        if (!normalized) {
          const message = 'MCP extraction returned invalid memory payload';
          await recordExtractionError('invalid_payload', 502, message);
          logOp('dashboard.extract_status', 'error', {
            trace,
            phase: 'outcome',
            status: 'err',
            job_id: jobId,
            proxy_target: statusUrl,
            reason: 'invalid_payload',
            err: message,
            dur_ms: Date.now() - startedAt,
          });
          return NextResponse.json({
            status: 'error',
            chunks_done: chunksDone,
            chunks_total: chunksTotal,
            error: message,
          });
        }
        normalizedMemories.push(normalized);
      }

      const mcpEmptyReason =
        isRecord(result.meta) && typeof result.meta.emptyReason === 'string'
          ? result.meta.emptyReason
          : undefined;
      const emptyReason = normalizedMemories.length === 0
        ? (mcpEmptyReason ?? 'no_durable_memories')
        : undefined;

      logOp('dashboard.extract_status', 'info', {
        trace,
        phase: 'outcome',
        status: 'ok',
        job_id: jobId,
        proxy_target: statusUrl,
        upstream_status: response.status,
        chunks_done: chunksDone,
        chunks_total: chunksTotal,
        memories: normalizedMemories.length,
        empty: normalizedMemories.length === 0,
        dur_ms: Date.now() - startedAt,
      });

      return NextResponse.json({
        status: 'done',
        chunks_done: chunksDone,
        chunks_total: chunksTotal,
        memories: normalizedMemories,
        ...(emptyReason ? { empty_reason: emptyReason } : {}),
      });
    }

    const invalidStatusMessage = 'MCP extraction status returned invalid status';
    await recordExtractionError('invalid_payload', 502, invalidStatusMessage);
    logOp('dashboard.extract_status', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      job_id: jobId,
      proxy_target: statusUrl,
      upstream_status: response.status,
      reason: 'invalid_status',
      err: invalidStatusMessage,
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: invalidStatusMessage }, { status: 502 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOp('dashboard.extract_status', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      err: fullErrorText(error),
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
