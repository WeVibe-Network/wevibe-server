'use client';

import { toast } from 'sonner';

import type { DiagnosticEntry, DiagnosticLevel } from '@/lib/diagnostics-types';

export interface DiagnosticsErrorListProps {
  entries: DiagnosticEntry[];
  emptyText?: string;
  loading?: boolean;
  minWidthClass?: string;
}

export function toEpoch(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) {
    return ts;
  }
  return new Date(parsed).toLocaleString();
}

export function levelBadgeClass(level: DiagnosticLevel): string {
  if (level === 'ERROR') {
    return 'border border-[rgba(255,107,107,0.5)] bg-[rgba(255,107,107,0.14)] text-wv-red';
  }
  if (level === 'WARN') {
    return 'border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.14)] text-wv-amber';
  }
  return 'border border-wv-line bg-wv-panel-2 text-wv-dim';
}

export function DiagnosticsErrorList({
  entries,
  emptyText,
  loading,
  minWidthClass = 'min-w-[1080px]',
}: DiagnosticsErrorListProps) {
  const handleCopyLine = async (entry: DiagnosticEntry) => {
    try {
      await navigator.clipboard.writeText(entry.rawLine);
      toast.success('Copied line');
    } catch {
      toast.error('Failed to copy line');
    }
  };

  if (loading) {
    return <div className="px-4 py-10 text-center text-sm text-wv-dim">Loading…</div>;
  }

  if (entries.length === 0) {
    return <div className="px-4 py-10 text-center text-sm text-wv-dim">{emptyText ?? 'No errors in the selected window.'}</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className={`${minWidthClass} w-full table-auto`}>
        <thead className="bg-wv-panel-2 text-left text-xs uppercase tracking-[0.08em] text-wv-dim">
          <tr>
            <th className="px-3 py-2 font-medium">Timestamp</th>
            <th className="px-3 py-2 font-medium">Level</th>
            <th className="px-3 py-2 font-medium">Service</th>
            <th className="px-3 py-2 font-medium">Operation</th>
            <th className="px-3 py-2 font-medium">Trace</th>
            <th className="px-3 py-2 font-medium">Message</th>
            <th className="px-3 py-2 font-medium">Copy</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.ts}-${entry.trace}-${index}`} className="border-t border-wv-line align-top">
              <td className="px-3 py-3 font-mono text-xs text-wv-dim">{formatTimestamp(entry.ts)}</td>
              <td className="px-3 py-3">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${levelBadgeClass(entry.level)}`}>
                  {entry.level}
                </span>
              </td>
              <td className="px-3 py-3 text-sm text-wv-text">{entry.service}</td>
              <td className="px-3 py-3 font-mono text-xs text-wv-dim">{entry.op}</td>
              <td className="px-3 py-3">
                <span className="block max-w-[220px] truncate font-mono text-xs text-wv-dim" title={entry.trace}>
                  {entry.trace}
                </span>
              </td>
              <td className="px-3 py-3">
                <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm leading-5 text-wv-text">
                  {entry.message}
                </div>
              </td>
              <td className="px-3 py-3">
                <button
                  type="button"
                  onClick={() => {
                    void handleCopyLine(entry);
                  }}
                  className="rounded-md border border-wv-line bg-wv-panel-2 px-2.5 py-1 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
                >
                  Copy
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
