'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getIdentity } from '@/lib/wevibe-auth';
import {
  Report,
  ReportAction,
  listReports,
  updateReport,
} from '@/lib/hub-client';
import { buildReportMemoryMsg, directBroadcast } from '@/lib/chain-client';
import { connectWallet } from '@/lib/wallet-connect';
import { useOrgContext } from '@/lib/org-context';
import ClientTime from '@/components/ui/client-time';

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

function shortCid(cid: string): string {
  if (cid.length <= 18) return cid;
  return `${cid.slice(0, 12)}…${cid.slice(-4)}`;
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'pending') return 'bg-[rgba(255,178,85,0.12)] text-wv-amber';
  if (normalized === 'upheld_pending_tx') return 'bg-[rgba(255,178,85,0.18)] text-wv-amber';
  if (normalized === 'upheld') return 'bg-[rgba(255,107,107,0.12)] text-wv-red';
  if (normalized === 'dismissed' || normalized === 'dismissed_malicious') return 'bg-[rgba(54,211,153,0.12)] text-wv-green';
  return 'bg-wv-panel-2 text-wv-dim';
}

export default function ReportsPage() {
  const router = useRouter();
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id ?? '';
  const [activeTab, setActiveTab] = useState<TabValue>('all');
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);

  const statusFilter = useMemo(() => (activeTab === 'all' ? undefined : activeTab), [activeTab]);

  const refreshReports = useCallback(async () => {
    if (!orgId || !identityReady) return;
    setLoading(true);
    setError(null);
    try {
      const response = await listReports(orgId, statusFilter, 100, 0);
      setReports(response.reports ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [identityReady, orgId, statusFilter]);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const id = await getIdentity();
      if (!id) {
        router.push('/login');
        return;
      }
      setIdentityReady(true);
    })().catch((err) => setError((err as Error).message));
  }, [orgId, router]);

  useEffect(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    if (!identityReady) return;
    void refreshReports();
  }, [orgId, identityReady, refreshReports]);

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
      if (!orgId) return;
      const confirmMessage = ACTION_CONFIRMATION[action];
      if (confirmMessage && !window.confirm(confirmMessage)) {
        return;
      }

      setBusy(report.id);
      setError(null);
      setNotice(null);
      try {
        await updateReport(orgId, report.id, action);
        const successCopy = SUCCESS_MESSAGES[action] ?? 'Report updated';
        setNotice(`${successCopy} ${shortCid(report.memory_cid)}.`);
        await refreshReports();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [orgId, refreshReports],
  );

  const handleCommitReport = useCallback(
    async (report: Report, reason: string) => {
      if (!orgId) return;
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
        const msgReportMemory = buildReportMemoryMsg({
          signer: walletConn.address,
          orgId,
          contentHash,
          contributorPubkey: report.reporter_pubkey,
          approvingModerators: [],
          upholdingModerators: [],
          reporterPubkey: report.reporter_pubkey,
          reason,
        });

        const result = await directBroadcast(walletConn.address, [msgReportMemory]);
        const txHash = result.txHash;
        setNotice(`Report committed to chain. TX: ${txHash.slice(0, 12)}...`);
        await refreshReports();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [orgId, refreshReports],
  );

  if (!orgId) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Memory Reports</h1>
          <p className="text-sm text-wv-amber">
            No organization selected. Please select an organization first.
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
            <p className="text-sm text-wv-dim">
              Track, escalate, and resolve memory abuse reports sourced from the hub API.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshReports()}
            disabled={loading}
            className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-text shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
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
                  ? 'bg-wv-grad-btn text-white shadow-wv-sm'
                  : 'border border-wv-line text-wv-dim hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">
          {notice}
        </div>
      )}

      {loading && reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          Loading reports…
        </div>
      ) : null}

      {!loading && reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          No reports match this filter yet. When moderators submit new reports, they will appear here.
        </div>
      ) : null}

      {reports.length > 0 ? (
        <>
          <div className="hidden overflow-hidden rounded-2xl border border-wv-line bg-wv-panel shadow-wv-sm md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-wv-panel-2 text-xs uppercase tracking-wide text-wv-dim">
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
              <tbody className="divide-y divide-wv-line">
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
                          <span className="font-mono text-xs text-wv-dim">{shortCid(report.memory_cid)}</span>
                          <div className="flex items-center gap-2 text-xs text-wv-faint">
                            <button
                              type="button"
                              onClick={() => handleCopy(report.memory_cid)}
                              className="rounded-md border border-transparent px-2 py-0.5 transition hover:border-wv-line hover:text-wv-dim"
                            >
                              Copy CID
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="space-y-1">
                          <span className="font-medium text-wv-text">{formatReason(report.reason)}</span>
                          {report.note ? (
                            <p className="text-xs text-wv-dim">{report.note}</p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="space-y-1 text-xs">
                          <span className="font-mono text-wv-dim">{shortCid(report.reporter_pubkey)}</span>
                          {report.reporter_wallet ? (
                            <span className="font-mono text-wv-faint">{shortCid(report.reporter_wallet)}</span>
                          ) : null}
                          <span className="inline-flex items-center rounded-full bg-wv-panel-2 px-2 py-0.5 text-[11px] uppercase tracking-wide text-wv-dim">
                            {report.reporter_role}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-xs text-wv-dim">
                        {reporterDismissed > 0 ? (
                          <span className="text-wv-amber font-medium">{reporterDismissed}</span>
                        ) : (
                          <span className="text-wv-faint">0</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-xs text-wv-dim">
                        {votes}/{threshold}
                      </td>
                      <td className="px-4 py-4 text-xs text-wv-dim"><ClientTime value={report.created_at} mode="datetime" /></td>
                      <td className="px-4 py-4">
                        <div className="space-y-1 text-xs text-wv-dim">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(report.status)}`}>
                            {statusLabel || 'Unknown'}
                          </span>
                          {resolution ? (
                            <span className="text-wv-dim">{resolution}</span>
                          ) : null}
                          {report.resolved_by ? (
                            <span className="font-mono text-wv-faint">by {shortCid(report.resolved_by)}</span>
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
                                className="inline-flex items-center rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-1.5 text-xs font-medium text-wv-green shadow-wv-sm transition hover:bg-[rgba(54,211,153,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === report.id ? 'Working…' : 'Uphold'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleAction(report, 'dismiss')}
                                disabled={busy === report.id}
                                className="inline-flex items-center rounded-lg border border-wv-line px-3 py-1.5 text-xs font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(255,107,107,0.4)] hover:text-wv-red disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {busy === report.id ? 'Working…' : 'Dismiss'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleAction(report, 'dismiss_malicious')}
                                disabled={busy === report.id}
                                className="inline-flex items-center rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-1.5 text-xs font-medium text-wv-red shadow-wv-sm transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
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
                              className="inline-flex items-center rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-1.5 text-xs font-medium text-wv-amber shadow-wv-sm transition hover:bg-[rgba(255,178,85,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
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
                      <article key={report.id} className="rounded-2xl border border-wv-line bg-wv-panel p-4 shadow-wv-sm">
                        <div className="flex flex-col gap-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono text-xs text-wv-dim">{shortCid(report.memory_cid)}</span>
                            <button
                              type="button"
                              onClick={() => handleCopy(report.memory_cid)}
                              className="rounded-md border border-transparent px-2 py-0.5 text-xs text-wv-dim transition hover:border-wv-line hover:text-wv-text"
                            >
                              Copy CID
                            </button>
                          </div>
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-wv-text">{formatReason(report.reason)}</p>
                            {report.note ? <p className="text-xs text-wv-dim">{report.note}</p> : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                            <span className="font-mono text-wv-dim">{shortCid(report.reporter_pubkey)}</span>
                            {report.reporter_wallet ? (
                              <span className="font-mono text-wv-faint">{shortCid(report.reporter_wallet)}</span>
                            ) : null}
                            <span className="inline-flex items-center rounded-full bg-wv-panel-2 px-2 py-0.5 text-[11px] uppercase tracking-wide text-wv-dim">
                              {report.reporter_role}
                            </span>
                            {reporterDismissed > 0 && (
                              <span className="text-wv-amber font-medium">Dismissed: {reporterDismissed}</span>
                            )}
                          </div>
                          <div className="text-xs text-wv-dim">Votes {votes}/{threshold} · Created <ClientTime value={report.created_at} mode="datetime" /></div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(report.status)}`}>
                              {statusLabel || 'Unknown'}
                            </span>
                            {resolution ? <span>{resolution}</span> : null}
                            {report.resolved_by ? <span className="font-mono text-wv-faint">by {shortCid(report.resolved_by)}</span> : null}
                          </div>
                          <div className="flex flex-wrap gap-2 pt-2">
                            {showPending ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleAction(report, 'uphold')}
                                  disabled={busy === report.id}
                                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-1.5 text-xs font-medium text-wv-green shadow-wv-sm transition hover:bg-[rgba(54,211,153,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy === report.id ? 'Working…' : 'Uphold'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAction(report, 'dismiss')}
                                  disabled={busy === report.id}
                                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-wv-line px-3 py-1.5 text-xs font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(255,107,107,0.4)] hover:text-wv-red disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {busy === report.id ? 'Working…' : 'Dismiss'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAction(report, 'dismiss_malicious')}
                                  disabled={busy === report.id}
                                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-1.5 text-xs font-medium text-wv-red shadow-wv-sm transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
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
                                className="inline-flex flex-1 items-center justify-center rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-1.5 text-xs font-medium text-wv-amber shadow-wv-sm transition hover:bg-[rgba(255,178,85,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
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
