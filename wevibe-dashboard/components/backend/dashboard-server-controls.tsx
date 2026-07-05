'use client';

import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { BackendActionResult, BackendStatus } from '@/lib/backend-types';
import type { ConnectionError, DiagnosticEntry, DiagnosticsResponse } from '@/lib/diagnostics-types';
import { getMcpClient } from '@/lib/mcp-client';

export interface DashboardServerControlsProps {
  /** 'full' = a settings-page section (headings + detail); 'inline' = compact (modal / block-screen). Default 'full'. */
  variant?: 'full' | 'inline';
  /** Optional callback fired after a successful start + reconnect (e.g. so a block screen can re-check). */
  onConnected?: () => void;
  className?: string;
}

type BackendAction = 'start' | 'stop' | 'restart';

const STATUS_POLL_MS = 4_000;
const DEFAULT_LOG_PATH_HINT = 'wevibe-meta/.logs/dashboard-mcp.log';

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBackendStatus(value: unknown, fallback: BackendStatus | null): BackendStatus {
  if (!isRecord(value)) {
    return fallback ?? {
      running: false,
      pid: null,
      healthy: false,
      detail: 'No backend status available.',
    };
  }

  const running = typeof value.running === 'boolean' ? value.running : fallback?.running ?? false;
  const healthy = typeof value.healthy === 'boolean' ? value.healthy : fallback?.healthy ?? false;
  const pid = typeof value.pid === 'number' && Number.isFinite(value.pid)
    ? value.pid
    : fallback?.pid ?? null;
  const detail = typeof value.detail === 'string' && value.detail.trim().length > 0
    ? value.detail
    : fallback?.detail ?? 'No backend status detail provided.';

  return {
    running,
    pid,
    healthy,
    detail,
  };
}

function normalizeBackendActionResult(value: unknown, fallbackStatus: BackendStatus | null): BackendActionResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const ok = typeof value.ok === 'boolean' ? value.ok : false;
  const detail = typeof value.detail === 'string' && value.detail.trim().length > 0
    ? value.detail
    : ok
      ? 'Action completed.'
      : 'Action failed.';
  const status = normalizeBackendStatus(value.status, fallbackStatus);
  const logPath = typeof value.logPath === 'string' && value.logPath.trim().length > 0
    ? value.logPath
    : undefined;

  return {
    ok,
    status,
    detail,
    logPath,
  };
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  return isRecord(value) && typeof value.service === 'string' && typeof value.rawLine === 'string';
}

function formatConnectionError(error: ConnectionError): string {
  return `${error.at}  CONNECTION ERROR  url=${error.url}  ${error.message}`;
}

function statusPresentation(status: BackendStatus | null): {
  dotClass: string;
  label: string;
  shortLabel: string;
} {
  if (!status) {
    return {
      dotClass: 'bg-wv-amber animate-pulse',
      label: 'Checking :4451 status…',
      shortLabel: 'Checking…',
    };
  }

  if (status.running && status.healthy) {
    return {
      dotClass: 'bg-wv-green',
      label: 'Running (healthy)',
      shortLabel: 'Running',
    };
  }

  if (status.running) {
    return {
      dotClass: 'bg-wv-amber',
      label: 'Running (starting / unhealthy)',
      shortLabel: 'Running (unhealthy)',
    };
  }

  return {
    dotClass: 'bg-wv-red',
    label: 'Down',
    shortLabel: 'Down',
  };
}

export function DashboardServerControls(props: DashboardServerControlsProps): JSX.Element {
  const { variant = 'full', onConnected, className } = props;
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [statusFetchError, setStatusFetchError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BackendAction | null>(null);
  const [logPathHint, setLogPathHint] = useState(DEFAULT_LOG_PATH_HINT);

  const busy = busyAction !== null;
  const running = status?.running ?? false;
  const presentation = useMemo(() => statusPresentation(status), [status]);

  const refreshStatus = useCallback(async (isActive: (() => boolean) | null = null): Promise<BackendStatus | null> => {
    const shouldUpdate = isActive ?? (() => true);

    try {
      const response = await fetch('/api/backend/status', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to load :4451 status (${response.status}).`);
      }

      const payload = await response.json();
      const nextStatus = normalizeBackendStatus(payload, null);

      if (!shouldUpdate()) {
        return nextStatus;
      }

      setStatus(nextStatus);
      setStatusFetchError(null);
      return nextStatus;
    } catch (error) {
      if (!shouldUpdate()) {
        return null;
      }

      const message = error instanceof Error ? error.message : 'Failed to load :4451 status.';
      setStatusFetchError(message);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;

    void refreshStatus(() => active);

    const intervalId = window.setInterval(() => {
      void refreshStatus(() => active);
    }, STATUS_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [refreshStatus]);

  const runAction = useCallback(async (action: BackendAction) => {
    if (busyAction) {
      return;
    }

    setBusyAction(action);

    try {
      const response = await fetch(`/api/backend/${action}`, {
        method: 'POST',
        cache: 'no-store',
      });

      const payload = await response.json().catch(() => null);
      const result = normalizeBackendActionResult(payload, status);

      if (!result) {
        throw new Error(`Invalid response from /api/backend/${action} (${response.status}).`);
      }

      setStatus(result.status);
      if (result.logPath) {
        setLogPathHint(result.logPath);
      }

      if (result.ok) {
        toast.success(result.detail);
      } else {
        toast.error(result.detail);
      }

      if ((action === 'start' || action === 'restart') && result.ok && result.status.healthy) {
        void getMcpClient().connect().catch(() => {});
        onConnected?.();
      }

      await refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to ${action} :4451 dashboard-server.`;
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, onConnected, refreshStatus, status]);

  const handleCopyErrorDetail = useCallback(async () => {
    if (busy) {
      return;
    }

    const lines: string[] = [];
    const clientError = getMcpClient().lastError;
    if (clientError) {
      lines.push(formatConnectionError(clientError));
    }

    try {
      const response = await fetch('/api/errors?levels=error&limit=50', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to load recent errors (${response.status}).`);
      }

      const payload = (await response.json()) as DiagnosticsResponse;
      const relatedErrors = Array.isArray(payload.entries)
        ? payload.entries
          .filter((entry): entry is DiagnosticEntry => isDiagnosticEntry(entry))
          .filter((entry) => entry.service === 'client' || entry.rawLine.includes('4451'))
          .map((entry) => entry.rawLine)
        : [];

      lines.push(...relatedErrors);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load :4451 error detail.';
      toast.error(message);
    }

    const uniqueLines = lines.filter((line, index) => line.trim().length > 0 && lines.indexOf(line) === index);
    if (uniqueLines.length === 0) {
      toast('No error detail to copy');
      return;
    }

    try {
      await navigator.clipboard.writeText(uniqueLines.join('\n'));
      toast.success('Copied error detail');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to copy error detail';
      toast.error(message);
    }
  }, [busy]);

  const controlBaseClass = joinClasses(
    'rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
    variant === 'inline' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
  );
  const primaryControlClass = joinClasses(controlBaseClass, 'bg-wv-grad-btn text-white shadow-wv-sm');
  const secondaryControlClass = joinClasses(controlBaseClass, 'border border-wv-line bg-wv-panel-2 text-wv-text');

  return (
    <section
      className={joinClasses(
        'rounded-lg border border-wv-line bg-wv-panel',
        variant === 'full' ? 'p-5' : 'p-3',
        className,
      )}
    >
      {variant === 'full' ? (
        <div>
          <h3 className="text-base font-semibold text-wv-text">Dashboard-server (:4451) control</h3>
          <p className="mt-1 text-sm text-wv-dim">
            Starts/stops the local :4451 dashboard-server (leader encrypt/moderation/decrypt). Start kills any existing :4451 first.
          </p>
        </div>
      ) : null}

      <div className={joinClasses('flex gap-3', variant === 'inline' ? 'mt-0 flex-col' : 'mt-4 flex-col')}>
        <div className="rounded-md border border-wv-line bg-wv-panel-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={joinClasses('h-2.5 w-2.5 rounded-full', presentation.dotClass)} />
            <span className="text-sm font-medium text-wv-text">
              {variant === 'inline' ? presentation.shortLabel : presentation.label}
            </span>
            {status?.running && status.pid !== null ? (
              <span className="rounded border border-wv-line px-2 py-0.5 font-mono text-[11px] text-wv-dim">PID {status.pid}</span>
            ) : null}
          </div>

          {status ? (
            <p className={joinClasses('mt-1 text-wv-dim', variant === 'inline' ? 'truncate text-xs' : 'text-sm')}>
              {status.detail}
            </p>
          ) : (
            <p className={joinClasses('mt-1 text-wv-dim', variant === 'inline' ? 'text-xs' : 'text-sm')}>
              Fetching :4451 status…
            </p>
          )}

          {statusFetchError ? (
            <p className={joinClasses('mt-1 text-wv-red', variant === 'inline' ? 'text-xs' : 'text-sm')}>
              {statusFetchError}
            </p>
          ) : null}

          {variant === 'full' ? (
            <p className="mt-1 text-xs text-wv-dim">
              Log hint: <span className="font-mono text-wv-text">{logPathHint}</span>
            </p>
          ) : null}
        </div>

        <div className={joinClasses('flex flex-wrap gap-2', variant === 'inline' ? 'items-center' : 'items-start')}>
          <button
            type="button"
            onClick={() => {
              void runAction('start');
            }}
            disabled={busy || running}
            className={running ? secondaryControlClass : primaryControlClass}
          >
            {busyAction === 'start' ? 'Starting…' : 'Start'}
          </button>

          <button
            type="button"
            onClick={() => {
              void runAction('stop');
            }}
            disabled={busy || !running}
            className={secondaryControlClass}
          >
            {busyAction === 'stop' ? 'Stopping…' : 'Stop'}
          </button>

          <button
            type="button"
            onClick={() => {
              void runAction('restart');
            }}
            disabled={busy || !running}
            className={running ? primaryControlClass : secondaryControlClass}
          >
            {busyAction === 'restart' ? 'Restarting…' : 'Restart'}
          </button>

          <button
            type="button"
            onClick={() => {
              void refreshStatus();
            }}
            disabled={busy}
            className={secondaryControlClass}
          >
            Refresh
          </button>

          <button
            type="button"
            onClick={() => {
              void handleCopyErrorDetail();
            }}
            disabled={busy}
            className={secondaryControlClass}
          >
            Copy error
          </button>
        </div>
      </div>
    </section>
  );
}
