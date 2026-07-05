import { NextResponse } from 'next/server';

import { getBackendStatus } from '@/lib/backend-control';
import type { BackendStatus } from '@/lib/backend-types';
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

export async function GET(request: Request): Promise<Response> {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));

  logOp('dashboard.backend_status', 'info', {
    trace,
    phase: 'entry',
  });

  try {
    const status = await getBackendStatus();

    logOp('dashboard.backend_status', 'info', {
      trace,
      phase: 'outcome',
      running: status.running,
      healthy: status.healthy,
      pid: status.pid,
    });

    return NextResponse.json(status satisfies BackendStatus);
  } catch (error) {
    logOp('dashboard.backend_status', 'error', {
      trace,
      phase: 'outcome',
      status: 'error',
      err: errorFullText(error),
    });

    const down: BackendStatus = {
      running: false,
      pid: null,
      healthy: false,
      detail: errorMessage(error),
    };

    return NextResponse.json(down, { status: 500 });
  }
}
