import { NextResponse } from 'next/server';

import { readClearMarker, writeClearMarker } from '@/lib/diagnostics-clear-marker';
import { type DiagnosticsClearState } from '@/lib/diagnostics-types';
import { TRACE_HEADER, logOp, resolveTraceId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    const json = JSON.stringify(error);
    return typeof json === 'string' ? json : String(error);
  } catch {
    return String(error);
  }
}

export async function POST(request: Request) {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));

  logOp('diagnostics.clear', 'info', {
    trace,
    phase: 'entry',
  });

  try {
    const cleared_at = writeClearMarker();

    logOp('diagnostics.clear', 'info', {
      trace,
      phase: 'outcome',
      status: 'ok',
      cleared_at,
    });

    return NextResponse.json({
      cleared_at,
    } satisfies DiagnosticsClearState);
  } catch (error) {
    logOp('diagnostics.clear', 'error', {
      trace,
      phase: 'outcome',
      status: 'error',
      err: formatError(error),
    });

    return NextResponse.json(
      {
        cleared_at: null,
      } satisfies DiagnosticsClearState,
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    cleared_at: readClearMarker(),
  } satisfies DiagnosticsClearState);
}
