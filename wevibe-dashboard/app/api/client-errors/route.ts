import { NextResponse } from 'next/server';
import type { ClientErrorPayload } from '@/lib/diagnostics-types';
import { logOp, resolveTraceId, TRACE_HEADER } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const trace = resolveTraceId(request.headers.get(TRACE_HEADER));

  try {
    const payload = (await request.json()) as ClientErrorPayload;

    logOp('client.error', 'error', {
      trace,
      kind: payload.kind,
      url: payload.url,
      message: payload.message,
      stack: payload.stack,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logOp('client.error', 'error', {
      trace,
      phase: 'ingest_error',
      err: String(err),
    });

    return NextResponse.json({ ok: false });
  }
}
