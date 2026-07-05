'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { DiagnosticsErrorList, formatTimestamp, toEpoch } from '@/components/diagnostics/error-list';
import { useDiagnosticsClear } from '@/components/diagnostics/use-diagnostics-clear';
import type { DiagnosticEntry, DiagnosticLevel, DiagnosticsResponse } from '@/lib/diagnostics-types';

const REFRESH_INTERVAL_MS = 5000;
const LEVEL_OPTIONS: DiagnosticLevel[] = ['ERROR', 'WARN'];

function toggleChipClass(active: boolean): string {
  if (active) {
    return 'border-[rgba(124,92,255,0.45)] bg-[rgba(124,92,255,0.14)] text-wv-violet';
  }
  return 'border-wv-line bg-wv-panel-2 text-wv-dim hover:text-wv-text';
}

export default function DiagnosticsPage() {
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState(true);
  const [matched, setMatched] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [selectedLevels, setSelectedLevels] = useState<DiagnosticLevel[]>(['ERROR', 'WARN']);
  const [selectedService, setSelectedService] = useState<string>('all');
  const [includeCleared, setIncludeCleared] = useState(false);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [hiddenByClear, setHiddenByClear] = useState(0);

  const availableServices = useMemo(() => {
    const unique = Array.from(new Set(services.filter((service) => service.trim().length > 0)));
    if (selectedService !== 'all' && !unique.includes(selectedService)) {
      unique.unshift(selectedService);
    }
    return unique;
  }, [services, selectedService]);

  const visibleEntries = useMemo(() => {
    return [...entries]
      .filter((entry) => selectedLevels.includes(entry.level))
      .filter((entry) => selectedService === 'all' || entry.service === selectedService)
      .sort((a, b) => toEpoch(b.ts) - toEpoch(a.ts));
  }, [entries, selectedLevels, selectedService]);

  const loadDiagnostics = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    const params = new URLSearchParams();
    const levelsParam = LEVEL_OPTIONS.filter((level) => selectedLevels.includes(level))
      .map((level) => level.toLowerCase())
      .join(',');
    if (levelsParam.length > 0) {
      params.set('levels', levelsParam);
    }
    params.set('limit', '500');
    params.set('sinceHours', '24');
    if (selectedService !== 'all') {
      params.set('service', selectedService);
    }
    if (includeCleared) {
      params.set('includeCleared', 'true');
    }

    try {
      const response = await fetch(`/api/errors?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Diagnostics fetch failed (${response.status})`);
      }

      const payload = (await response.json()) as DiagnosticsResponse;
      const nextEntries = Array.isArray(payload.entries) ? payload.entries : [];
      const nextServices = Array.isArray(payload.services) ? payload.services : [];
      const nextNotes = Array.isArray(payload.notes) ? payload.notes : [];

      setEntries(nextEntries);
      setServices(nextServices);
      setNotes(nextNotes);
      setDockerAvailable(payload.dockerAvailable !== false);
      setMatched(typeof payload.matched === 'number' ? payload.matched : nextEntries.length);
      setClearedAt(payload.clearedAt ?? null);
      setHiddenByClear(typeof payload.hiddenByClear === 'number' ? payload.hiddenByClear : 0);
      setErrorText(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load diagnostics';
      setErrorText(message);
      toast.error('Failed to load diagnostics');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [includeCleared, selectedLevels, selectedService]);

  const handleCleared = useCallback(() => {
    setEntries([]);
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const { clearing, clear } = useDiagnosticsClear(handleCleared);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  useEffect(() => {
    if (paused) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadDiagnostics(true);
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [loadDiagnostics, paused]);

  const handleToggleLevel = (level: DiagnosticLevel) => {
    setSelectedLevels((previous) => {
      const includesLevel = previous.includes(level);
      if (includesLevel && previous.length === 1) {
        return previous;
      }
      if (includesLevel) {
        return previous.filter((item) => item !== level);
      }
      return [...previous, level];
    });
  };

  const handleCopyAllVisible = useCallback(async () => {
    if (visibleEntries.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(visibleEntries.map((entry) => entry.rawLine).join('\n'));
      toast.success(`Copied ${visibleEntries.length} lines`);
    } catch {
      toast.error('Failed to copy visible lines');
    }
  }, [visibleEntries]);

  const infoNotes = useMemo(() => {
    if (notes.length > 0) {
      return notes;
    }
    if (!dockerAvailable) {
      return ['Docker merge unavailable; hub-via-docker logs were skipped for this scan.'];
    }
    return [];
  }, [dockerAvailable, notes]);

  return (
    <div className="space-y-6 bg-wv-bg p-6 text-wv-text">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-wv-text">Diagnostics</h1>
          <p className="mt-1 text-sm text-wv-dim">
            Aggregated error and warning lines from WeVibe services for quick scan and copy/paste.
          </p>
          <p className="mt-1 text-xs font-mono text-wv-faint">
            Showing {visibleEntries.length} visible / {matched} matched
          </p>
          <p className="mt-1 text-xs text-wv-faint">
            Clear hides current errors from this view; it does not delete logs or fix live errors.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
              paused
                ? 'border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.14)] text-wv-amber hover:bg-[rgba(255,178,85,0.2)]'
                : 'border-wv-line bg-wv-panel-2 text-wv-text hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet'
            }`}
          >
            {paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          </button>

          <button
            type="button"
            onClick={handleCopyAllVisible}
            disabled={visibleEntries.length === 0}
            className="rounded-md border border-wv-line bg-wv-panel-2 px-3 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-50"
          >
            Copy all (visible)
          </button>

          <button
            type="button"
            onClick={() => {
              void clear();
            }}
            disabled={clearing}
            className="rounded-md border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.14)] px-3 py-2 text-sm font-medium text-wv-amber transition hover:bg-[rgba(255,178,85,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {clearing ? 'Clearing…' : 'Clear'}
          </button>

          <button
            type="button"
            onClick={() => {
              void loadDiagnostics();
            }}
            className="rounded-md bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95"
          >
            Refresh
          </button>
        </div>
      </div>

      {(clearedAt || includeCleared) && (
        <div className="rounded-md border border-wv-line bg-wv-panel-2 px-3 py-2 text-xs text-wv-dim">
          {clearedAt && (
            <div className="flex flex-wrap items-center gap-2">
              <p>
                {hiddenByClear} error(s) hidden by clear at {formatTimestamp(clearedAt)} — logs are not deleted.
              </p>
              <button
                type="button"
                onClick={() => setIncludeCleared((value) => !value)}
                className="rounded border border-wv-line px-2 py-1 text-xs text-wv-text transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
              >
                {includeCleared ? 'Hide cleared' : 'Show all'}
              </button>
            </div>
          )}
          {includeCleared && <p className="mt-1">Showing full history (including cleared).</p>}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-wv-line bg-wv-panel p-4 shadow-wv-sm">
        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Level filters</p>
          <div className="flex flex-wrap gap-2">
            {LEVEL_OPTIONS.map((level) => {
              const active = selectedLevels.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => handleToggleLevel(level)}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${toggleChipClass(active)}`}
                >
                  {level === 'ERROR' ? 'Error' : 'Warn'}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Service filters</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectedService('all')}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${toggleChipClass(selectedService === 'all')}`}
            >
              All
            </button>
            {availableServices.map((service) => (
              <button
                key={service}
                type="button"
                onClick={() => setSelectedService(service)}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${toggleChipClass(selectedService === service)}`}
                title={service}
              >
                {service}
              </button>
            ))}
          </div>
        </div>

        {infoNotes.length > 0 && (
          <div className="rounded-md border border-wv-line bg-wv-panel-2 px-3 py-2 text-xs text-wv-dim">
            {!dockerAvailable && <p className="mb-1 text-wv-faint">Docker merge note:</p>}
            <ul className="space-y-1">
              {infoNotes.map((note, index) => (
                <li key={`${note}-${index}`}>• {note}</li>
              ))}
            </ul>
          </div>
        )}

        {errorText && (
          <div className="rounded-md border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
            {errorText}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-wv-line bg-wv-panel shadow-wv-sm">
        <DiagnosticsErrorList
          entries={visibleEntries}
          loading={loading}
          emptyText="No errors in the selected window."
        />
      </div>
    </div>
  );
}
