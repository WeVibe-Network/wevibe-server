import { NextResponse } from 'next/server';

import { getMcpHttpUrl } from '@/lib/config';
import {
  isRecord,
  readMcpSessionToken,
} from '@/lib/extract-shared';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';
import { MCP_OFFLINE_ERROR } from '@/lib/mcp-errors';

export const dynamic = 'force-dynamic';

const MCP_PARKED_TIMEOUT_MS = 15_000;

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

function upstreamErrorMessage(responseBody: unknown, statusCode: number): string {
  if (isRecord(responseBody) && typeof responseBody.error === 'string' && responseBody.error.trim().length > 0) {
    return responseBody.error;
  }

  return `MCP parked extraction fetch failed with status ${statusCode}`;
}

function parseParkedPayload(responseBody: unknown): { parked: unknown[] } | null {
  if (!isRecord(responseBody) || !Array.isArray(responseBody.parked)) {
    return null;
  }

  return { parked: responseBody.parked };
}

export async function GET(request: Request): Promise<Response> {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));
  const startedAt = Date.now();

  logOp('dashboard.extract_parked', 'info', {
    trace,
    phase: 'entry',
    method: 'GET',
  });

  try {
    let sessionToken: string | null;
    try {
      sessionToken = await readMcpSessionToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOp('dashboard.extract_parked', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'token_read',
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ parked: [], error: `Failed to read MCP session token: ${message}` }, { status: 500 });
    }

    if (!sessionToken) {
      logOp('dashboard.extract_parked', 'warn', {
        trace,
        phase: 'outcome',
        status: 'ok',
        reason: 'session_token_missing',
        has_session_token: false,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ parked: [], error: MCP_OFFLINE_ERROR }, { status: 503 });
    }

    const mcpHttpUrl = getMcpHttpUrl();
    const parkedUrl = new URL('/v1/extract/parked', mcpHttpUrl).toString();

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), MCP_PARKED_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(parkedUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          [TRACE_HEADER]: trace,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logOp('dashboard.extract_parked', 'warn', {
          trace,
          phase: 'outcome',
          status: 'ok',
          reason: 'timeout',
          proxy_target: parkedUrl,
          err: 'parked_extraction_timeout',
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json({ parked: [] }, { status: 200 });
      }

      const code = (error as { cause?: { code?: string } })?.cause?.code
        ?? (error as { code?: string })?.code;
      if (
        code === 'ECONNREFUSED'
        || code === 'ECONNRESET'
        || code === 'EAI_AGAIN'
        || code === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        logOp('dashboard.extract_parked', 'warn', {
          trace,
          phase: 'outcome',
          status: 'ok',
          reason: 'connection',
          proxy_target: parkedUrl,
          err: code,
          dur_ms: Date.now() - startedAt,
        });
        return NextResponse.json({ parked: [] }, { status: 200 });
      }

      const message = error instanceof Error ? error.message : String(error);
      logOp('dashboard.extract_parked', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'network',
        proxy_target: parkedUrl,
        err: fullErrorText(error),
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { parked: [], error: `extraction parked request to local WeVibe MCP failed: ${message}` },
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
      const message = upstreamErrorMessage(responseBody, response.status);
      logOp('dashboard.extract_parked', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'upstream',
        proxy_target: parkedUrl,
        upstream_status: response.status,
        err: message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ parked: [], error: message }, { status: response.status });
    }

    const payload = parseParkedPayload(responseBody);
    if (!payload) {
      const message = 'MCP parked extraction returned invalid payload';
      logOp('dashboard.extract_parked', 'error', {
        trace,
        phase: 'outcome',
        status: 'err',
        reason: 'invalid_payload',
        proxy_target: parkedUrl,
        upstream_status: response.status,
        err: message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ parked: [], error: message }, { status: 502 });
    }

    logOp('dashboard.extract_parked', 'info', {
      trace,
      phase: 'outcome',
      status: 'ok',
      proxy_target: parkedUrl,
      upstream_status: response.status,
      parked_jobs: payload.parked.length,
      dur_ms: Date.now() - startedAt,
    });

    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOp('dashboard.extract_parked', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      err: fullErrorText(error),
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ parked: [], error: message }, { status: 500 });
  }
}
