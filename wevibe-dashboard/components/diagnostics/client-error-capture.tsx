'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import type { ClientErrorPayload } from '@/lib/diagnostics-types';
import { ErrorFallback } from './error-fallback';

const REDACTION_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/\-=]+\b/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:key|token|secret|password)\s*=\s*[^&\s]+/gi,
  /\b0x[a-fA-F0-9]{64,}\b/g,
  /\b[a-fA-F0-9]{32,}\b/g,
];

function stripQueryString(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.pathname || '/';
  } catch {
    return value
      .replace(/(https?:\/\/[^\s"')\]]+)\?[^#\s"')\]]*/gi, '$1')
      .replace(/(\/[^\s"')\]]+)\?[^#\s"')\]]*/g, '$1');
  }
}

function scrub(text?: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined;
  }

  let next = stripQueryString(text);
  for (const pattern of REDACTION_PATTERNS) {
    next = next.replace(pattern, '[redacted]');
  }

  return next;
}

function scrubPayload(payload: ClientErrorPayload): ClientErrorPayload {
  const message = scrub(payload.message) ?? 'unknown client error';
  const stack = scrub(payload.stack);
  const url = scrub(payload.url);
  return { kind: payload.kind, message, stack, url };
}

function messageFromReason(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason) {
    return String((reason as { message?: unknown }).message);
  }
  return String(reason);
}

function stackFromReason(reason: unknown): string | undefined {
  if (reason && typeof reason === 'object' && 'stack' in reason) {
    return String((reason as { stack?: unknown }).stack);
  }
  return undefined;
}

type ClientErrorCaptureProps = {
  children: ReactNode;
};

export function ClientErrorCapture({ children }: ClientErrorCaptureProps) {
  const isPostingRef = useRef(false);

  const post = useCallback((payload: ClientErrorPayload): void => {
    if (isPostingRef.current) {
      return;
    }

    isPostingRef.current = true;
    const scrubbedPayload = scrubPayload(payload);

    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scrubbedPayload),
      keepalive: true,
    })
      .catch(() => {})
      .finally(() => {
        isPostingRef.current = false;
      });
  }, []);

  useEffect(() => {
    const previousOnError = window.onerror;

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      post({
        kind: 'unhandledrejection',
        message: messageFromReason(event.reason),
        stack: stackFromReason(event.reason),
        url: location.href,
      });
    };

    window.onerror = (msg, src, line, col, err) => {
      post({
        kind: 'onerror',
        message: String(msg),
        stack: err?.stack,
        url: location.href,
      });

      if (typeof previousOnError === 'function') {
        return previousOnError.call(window, msg, src, line, col, err);
      }

      return false;
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.onerror = previousOnError;
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [post]);

  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error) => {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;

        post({
          kind: 'boundary',
          message,
          stack,
          url: typeof location !== 'undefined' ? location.href : '',
        });
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
