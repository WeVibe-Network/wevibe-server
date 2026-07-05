'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DiagnosticsErrorList, formatTimestamp, toEpoch } from '@/components/diagnostics/error-list';
import { useDiagnosticsClear } from '@/components/diagnostics/use-diagnostics-clear';
import type { ConnectionError, DiagnosticEntry, DiagnosticsResponse } from '@/lib/diagnostics-types';

export interface ConnectionErrorModalProps {
  open: boolean;
  onClose: () => void;
  connectionError: ConnectionError | null;
}

export function ConnectionErrorModal({ open, onClose, connectionError }: ConnectionErrorModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [hiddenByClear, setHiddenByClear] = useState(0);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => toEpoch(b.ts) - toEpoch(a.ts));
  }, [entries]);

  const loadRecentErrors = useCallback(async (isActive: (() => boolean) | null = null) => {
    const shouldUpdate = isActive ?? (() => true);

    setLoading(true);
    setFetchError(null);

    try {
      const response = await fetch('/api/errors?levels=error,warn&limit=50', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to load recent errors (${response.status})`);
      }

      const payload = (await response.json()) as DiagnosticsResponse;
      if (!shouldUpdate()) {
        return;
      }

      setEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setClearedAt(payload.clearedAt ?? null);
      setHiddenByClear(typeof payload.hiddenByClear === 'number' ? payload.hiddenByClear : 0);
    } catch (error) {
      if (!shouldUpdate()) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to load recent errors.';
      setEntries([]);
      setFetchError(message);
      setClearedAt(null);
      setHiddenByClear(0);
    } finally {
      if (shouldUpdate()) {
        setLoading(false);
      }
    }
  }, []);

  const { clearing, clear } = useDiagnosticsClear(() => {
    setEntries([]);
    void loadRecentErrors();
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    let active = true;

    void loadRecentErrors(() => active);

    return () => {
      active = false;
    };
  }, [loadRecentErrors, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleDocumentKeyDown);

    const focusHandle = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
      window.cancelAnimationFrame(focusHandle);
    };
  }, [open, onClose]);

  const handleCopyConnectionError = async () => {
    if (!connectionError) {
      return;
    }

    const payload = `${connectionError.at}  CONNECTION ERROR  url=${connectionError.url}  ${connectionError.message}`;

    try {
      await navigator.clipboard.writeText(payload);
      toast.success('Copied connection error');
    } catch {
      toast.error('Failed to copy connection error');
    }
  };

  const handleCopyAll = async () => {
    if (sortedEntries.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(sortedEntries.map((entry) => entry.rawLine).join('\n'));
      toast.success(`Copied ${sortedEntries.length} lines`);
    } catch {
      toast.error('Failed to copy recent errors');
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-6 pt-20"
      role="dialog"
      aria-modal="true"
      aria-label="Connection diagnostics"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-3xl max-h-[80vh] overflow-auto rounded-lg border border-wv-line bg-wv-panel p-5 shadow-wv-md"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Connection diagnostics</h2>
            <p className="mt-1 text-sm text-wv-dim">View the current connection failure and recent warning/error logs.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-wv-line bg-wv-panel-2 px-2.5 py-1 text-sm font-medium text-wv-dim transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
            aria-label="Close connection diagnostics"
          >
            ×
          </button>
        </div>

        <div className="mt-5 space-y-4">
          {connectionError ? (
            <div className="rounded-md border border-[rgba(255,107,107,0.5)] bg-[rgba(255,107,107,0.14)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-wv-red">Active connection error</h3>
                <button
                  type="button"
                  onClick={() => {
                    void handleCopyConnectionError();
                  }}
                  className="rounded-md border border-[rgba(255,107,107,0.5)] bg-[rgba(30,30,40,0.35)] px-2.5 py-1 text-xs font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.2)]"
                >
                  Copy
                </button>
              </div>
              <p className="mt-3 whitespace-pre-wrap break-all font-mono text-xs leading-5 text-wv-text">{connectionError.message}</p>
              <p className="mt-2 break-all font-mono text-xs text-wv-dim">URL: {connectionError.url}</p>
              <p className="mt-1 font-mono text-xs text-wv-dim">At: {formatTimestamp(connectionError.at)}</p>
            </div>
          ) : (
            <p className="text-sm text-wv-dim">No active connection errors.</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-wv-text">Recent aggregated errors</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void clear();
                }}
                disabled={clearing || loading}
                className="rounded-md border border-[rgba(255,184,77,0.45)] bg-[rgba(255,184,77,0.12)] px-3 py-1.5 text-xs font-medium text-[rgba(255,220,170,0.95)] transition hover:bg-[rgba(255,184,77,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {clearing ? 'Clearing…' : 'Clear'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCopyAll();
                }}
                disabled={sortedEntries.length === 0 || loading}
                className="rounded-md border border-wv-line bg-wv-panel-2 px-3 py-1.5 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-50"
              >
                Copy all
              </button>
            </div>
          </div>

          {clearedAt ? (
            <p className="text-xs text-wv-dim">
              {hiddenByClear} older error(s) hidden (cleared {formatTimestamp(clearedAt)}). Logs are not deleted; live errors above are
              unaffected.
            </p>
          ) : null}

          {fetchError ? (
            <p className="rounded-md border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
              {fetchError}
            </p>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-wv-line bg-wv-panel-2">
            <DiagnosticsErrorList
              entries={sortedEntries}
              minWidthClass="min-w-[640px]"
              emptyText="No recent errors."
              loading={loading}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <Link
            href="/diagnostics"
            onClick={onClose}
            className="rounded-md bg-wv-grad-btn px-3 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95"
          >
            Open full Diagnostics →
          </Link>
        </div>
      </div>
    </div>
  );
}
