import { NextResponse } from 'next/server';

import { getBackendStatus, startBackend } from '@/lib/backend-control';
import type { BackendActionResult, BackendStatus } from '@/lib/backend-types';
import { TRACE_HEADER, logOp, resolveTraceId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorFullText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function safeStatus(): Promise<BackendStatus> {
  try {
    return await getBackendStatus();
  } catch (error) {
    return {
      running: false,
      pid: null,
      healthy: false,
      detail: `status unavailable: ${errorMessage(error)}`,
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));

  logOp('dashboard.backend_start', 'info', {
    trace,
    phase: 'entry',
  });

  try {
    const result = await startBackend(trace);

    logOp('dashboard.backend_start', result.ok ? 'info' : 'error', {
      trace,
      phase: 'outcome',
      status: result.ok ? 'ok' : 'err',
      ok: result.ok,
      detail: result.detail,
      pid: result.status.pid,
    });

    return NextResponse.json(result satisfies BackendActionResult, {
      status: result.ok ? 200 : 500,
    });
  } catch (error) {
    logOp('dashboard.backend_start', 'error', {
      trace,
      phase: 'outcome',
      status: 'error',
      err: errorFullText(error),
    });

    const result: BackendActionResult = {
      ok: false,
      status: await safeStatus(),
      detail: errorMessage(error),
    };

    return NextResponse.json(result, { status: 500 });
  }
}
