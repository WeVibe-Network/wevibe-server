'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOrCreateIdentity } from '@/lib/wevibe-auth';
import {
  Report,
  ReportAction,
  listReports,
  updateReport,
} from '@/lib/hub-client';
import { relayBroadcast } from '@/lib/relay-client';
import type { EncodeObject } from '@/lib/chain-client';
import { connectWallet } from '@/lib/wallet-connect';

const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID ?? '';

type TabValue = 'all' | 'pending' | 'upheld_pending_tx' | 'upheld' | 'dismissed';

const STATUS_TABS: Array<{ label: string; value: TabValue }> = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Upheld Pending TX', value: 'upheld_pending_tx' },
  { label: 'Upheld', value: 'upheld' },
  { label: 'Dismissed', value: 'dismissed' },
];

const ACTION_CONFIRMATION: Partial<Record<ReportAction, string>> = {
  uphold: 'Uphold this report? The memory will be deleted and a public record created.',
  dismiss: 'Dismiss this report? The memory will remain available.',
  dismiss_malicious: 'Dismiss as malicious? The reporter\'s dismissed_reports_count will be incremented.',
};

const SUCCESS_MESSAGES: Record<ReportAction, string> = {
  uphold: 'Report upheld — memory deleted',
  dismiss: 'Report dismissed',
  dismiss_malicious: 'Report dismissed as malicious',
};

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function formatReason(reason: string): string {
  if (!reason) return 'Unspecified';
  return titleCase(reason);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    return value;
  }
}

function shortCid(cid: string): string {
  if (cid.length <= 18) return cid;
  return `${cid.slice(0, 12)}…${cid.slice(-4)}`;
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'pending') return 'bg-amber-100 text-amber-800';
  if (normalized === 'upheld_pending_tx') return 'bg-orange-100 text-orange-700';
  if (normalized === 'upheld') return 'bg-rose-100 text-rose-700';
  if (normalized === 'dismissed' || normalized === 'dismissed_malicious') return 'bg-emerald-100 text-emerald-700';
  return 'bg-zinc-100 text-zinc-600';
}

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<TabValue>('all');
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);

  const statusFilter = useMemo(() => (activeTab === 'all' ? undefined : activeTab), [activeTab]);

  const refreshReports = useCallback(async () => {
    if (!ORG_ID || !identityReady) return;
    setLoading(true);
    setError(null);
    try {
      const response = await listReports(ORG_ID, statusFilter, 100, 0);
      setReports(response.reports ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [identityReady, statusFilter]);

  useEffect(() => {
    if (!ORG_ID) return;
    getOrCreateIdentity()
      .then(() => setIdentityReady(true))
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    void refreshReports();
  }, [identityReady, refreshReports]);

  const handleCopy = useCallback(async (cid: string) => {
    try {
      await navigator.clipboard.writeText(cid);
      setNotice('Copied memory CID to clipboard.');
    } catch (err) {
      const message = (err as Error).message || 'Copy failed';
      setError(message);
    }
  }, []);

const handleAction = useCallback(
    async (report: Report, action: ReportAction) => {
      if (!ORG_ID) return;
      const confirmMessage = ACTION_CONFIRMATION[action];
      if (confirmMessage && !window.confirm(confirmMessage)) {
        return;
      }

      setBusy(report.id);
      setError(null);
      setNotice(null);
      try {
        await updateReport(ORG_ID, report.id, action);
        const successCopy = SUCCESS_MESSAGES[action] ?? 'Report updated';
        setNotice(`${successCopy} ${shortCid(report.memory_cid)}.`);
        await refreshReports();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refreshReports],
  );

  const handleCommitReport = useCallback(
    async (report: Report, reason: string) => {
      if (!ORG_ID) return;
      if (reason.length > 500) {
        setError('Reason must be 500 characters or fewer');
        return;
      }

      const confirmMsg = 'Submit this report to the chain? This will create a permanent record linking the memory to the contributor wallet.';
      if (!window.confirm(confirmMsg)) {
        return;
      }

      setBusy(report.id);
      setError(null);
      setNotice(null);
      try {
        const walletConn = await connectWallet();

        const contentHash = Uint8Array.from(Buffer.from(report.memory_cid, 'hex'));
        const epoch = 0;

        const msgReportMemory: EncodeObject = {
          typeUrl: '/wevibe.memory.v1.MsgReportMemory',
          value: Buffer.from(JSON.stringify({
            signer: walletConn.address,
            org_id: ORG_ID,
            content_hash: contentHash,
            contributor_pubkey: report.reporter_pubkey,
            reporter_pubkey: report.reporter_pubkey,
            reason: report.reason,
          })),
        };

        const txHash = await relayBroadcast(ORG_ID, walletConn.address, [msgReportMemory]);
        setNotice(`Report committed to chain. TX: ${txHash.slice(0, 12)}...`);
        await refreshReports();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refreshReports],
  );

  if (!ORG_ID) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Memory Reports</h1>
          <p className="text-sm text-amber-700">
            Set <code>NEXT_PUBLIC_ORG_ID</code> in <code>.env.local</code> to query the hub report queue.
          </p>
        </header>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Memory Reports</h1>
            <p className="text-sm text-zinc-500">
              Track, escalate, and resolve memory abuse reports sourced from the hub API.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshReports()}
            disabled={loading}
            className="inline-flex items-center rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setActiveTab(tab.value)}
              className={`inline-flex items-center rounded-full px-4 py-1.5 text-sm font-medium transition ${
                activeTab === tab.value
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'border border-zinc-200 text-zinc-600 hover:border-indigo-300 hover:text-indigo-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {loading && reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-16 text-center text-sm text-zinc-500">
          Loading reports…
        </div>
      ) : null}

      {!loading && reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-16 text-center text-sm text-zinc-500">
          No reports match this filter yet. When moderators submit new reports, they will appear here.
        </div>
      ) : null}

      {reports.length > 0 ? (
        <>
          <div className="hidden overflow-hidden rounded-2xl border border-zinc-200 bg-white/80 shadow-sm md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Memory CID</th>
                  <th className="px-4 py-3 text-left font-medium">Reason</th>
                  <th className="px-4 py-3 text-left font-medium">Reporter</th>
                  <th className="px-4 py-3 text-left font-medium">Dismissed</th>
                  <th className="px-4 py-3 text-left font-medium">Votes</th>
                  <th className="px-4 py-3 text-left font-medium">Created</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {reports.map((report) => {
                  const votes = report.vote_count ?? 0;
                  const threshold = report.report_vote_threshold ?? 1;
                  const statusLabel = titleCase(report.status ?? '');
                  const showPending = report.status === 'pending';
                  const showPendingTX = report.status === 'upheld_pending_tx';
                  const reporterDismissed = report.reporter_dismissed_count ?? 0;
                  const resolution = report.resolution ?? null;

                  return (
                    <tr key={report.id} className="align-top">
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-xs text-zinc-600">{shortCid(report.memory_cid)}</span>
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            <button
                              type="button"
                              onClick={() => handleCopy(report.memory_cid)}
                              className="rounded-md border border-transparent px-2 py-0.5 transition hover:border-zinc-200 hover:text-zinc-600"
                            >
                              Copy CID
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="space-y-1">
                          <span className="font-medium text-zinc-800">{formatReason(report.reason)}</span>
                          {report.note ? (
                            <p className="text-xs text-zinc-500">{report.note}</p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="space-y-1 text-xs">
                          <span className="font-mono text-zinc-600">{shortCid(report.reporter_pubkey)}</span>
                          {report.reporter_wallet ? (
                            <span className="font-mono text-zinc-400">{shortCid(report.reporter_wallet)}</span>
                          ) : null}
                          <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-zinc-500">
                            {report.reporter_role}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-xs text-zinc-500">
                        {reporterDismissed > 0 ? (
                          <span className="text-amber-600 font-medium">{reporterDismissed}</span>
                        ) : (
                          <span className="text-zinc-300">0</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-xs text-zinc-500">
                        {votes}/{threshold}
                      </td>
                      <td className="px-4 py-4 text-xs text-zinc-500">{formatDate(report.created_at)}</td>
                      <td className="px-4 py-4">
                        <div className="space-y-1 text-xs text-zinc-600">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(report.status)}`}>
                            {statusLabel || 'Unknown'}
                          </span>
                          {resolution ? (
                            <span className="text-zinc-500">{resolution}</span>
                          ) : null}
                          {report.resolved_by ? (
                            <span className="text-zinc-400">by {shortCid(report.resolved_by)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          {showPending ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleAction(report, 'uphold')}
                                disabled={busy === report.id}
                                className="inline-flex items-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 shadow-sm transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === report.id ? 'Working…' : 'Uphold'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleAction(report, 'dismiss')}
                                disabled={busy === report.id}
                                className="inline-flex items-center rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition hover:border-rose-300 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === report.id ? 'Working…' : 'Dismiss'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleAction(report, 'dismiss_malicious')}
                                disabled={busy === report.id}
                                className="inline-flex items-center rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 shadow-sm transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === report.id ? 'Working…' : 'Malicious'}
                              </button>
                            </>
                          ) : null}
                          {showPendingTX ? (
                            <button
                              type="button"
                              onClick={async () => {
                                const reason = window.prompt('Enter reason for chain commitment (max 500 chars):');
                                if (reason !== null) {
                                  await handleCommitReport(report, reason);
                                }
                              }}
                              disabled={busy === report.id}
                              className="inline-flex items-center rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 shadow-sm transition hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {busy === report.id ? 'Working…' : 'Submit to Chain'}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-4 md:hidden">
            {reports.map((report) => {
              const votes = report.vote_count ?? 0;
              const threshold = report.report_vote_threshold ?? 1;
              const statusLabel = titleCase(report.status ?? '');
const showPending = report.status === 'pending';
                    const showPendingTX = report.status === 'upheld_pending_tx';
                    const reporterDismissed = report.reporter_dismissed_count ?? 0;
                    const resolution = report.resolution ?? null;

                    return (
                      <article key={report.id} className="rounded-2xl border border-zinc-200 bg-white/80 p-4 shadow-sm">
                        <div className="flex flex-col gap-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono text-xs text-zinc-600">{shortCid(report.memory_cid)}</span>
                            <button
                              type="button"
                              onClick={() => handleCopy(report.memory_cid)}
                              className="rounded-md border border-transparent px-2 py-0.5 text-xs text-zinc-500 transition hover:border-zinc-200 hover:text-zinc-700"
                            >
                              Copy CID
                            </button>
                          </div>
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-zinc-800">{formatReason(report.reason)}</p>
                            {report.note ? <p className="text-xs text-zinc-500">{report.note}</p> : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span className="font-mono text-zinc-600">{shortCid(report.reporter_pubkey)}</span>
                            {report.reporter_wallet ? (
                              <span className="font-mono text-zinc-400">{shortCid(report.reporter_wallet)}</span>
                            ) : null}
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-zinc-500">
                              {report.reporter_role}
                            </span>
                            {reporterDismissed > 0 && (
                              <span className="text-amber-600 font-medium">Dismissed: {reporterDismissed}</span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-500">Votes {votes}/{threshold} · Created {formatDate(report.created_at)}</div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(report.status)}`}>
                              {statusLabel || 'Unknown'}
                            </span>
                            {resolution ? <span>{resolution}</span> : null}
                            {report.resolved_by ? <span>by {shortCid(report.resolved_by)}</span> : null}
                          </div>
                          <div className="flex flex-wrap gap-2 pt-2">
                            {showPending ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleAction(report, 'uphold')}
                                  disabled={busy === report.id}
                                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 shadow-sm transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy === report.id ? 'Working…' : 'Uphold'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAction(report, 'dismiss')}
                                  disabled={busy === report.id}
                                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition hover:border-rose-300 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy === report.id ? 'Working…' : 'Dismiss'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAction(report, 'dismiss_malicious')}
                                  disabled={busy === report.id}
                                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 shadow-sm transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy === report.id ? 'Working…' : 'Malicious'}
                                </button>
                              </>
                            ) : null}
                            {showPendingTX ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  const reason = window.prompt('Enter reason for chain commitment (max 500 chars):');
                                  if (reason !== null) {
                                    await handleCommitReport(report, reason);
                                  }
                                }}
                                disabled={busy === report.id}
                                className="inline-flex flex-1 items-center justify-center rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 shadow-sm transition hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === report.id ? 'Working…' : 'Submit to Chain'}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
