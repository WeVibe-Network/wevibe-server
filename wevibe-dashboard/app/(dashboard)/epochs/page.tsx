'use client';
import { useCallback, useEffect, useState } from 'react';
import { getOrg, getEpochManifest, rotateEpoch, type OrgSummary } from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';
import { useDashboardState } from '@/lib/use-dashboard-state';
import ClientTime from '@/components/ui/client-time';

interface EpochHistoryEntry {
  epoch_id: number;
  pk_mod: string;
  signed_by: string;
  created_at: string;
}

export default function EpochPage() {
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id ?? '';
  const { isLeader, loading: dashLoading } = useDashboardState();

  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rotateSuccess, setRotateSuccess] = useState('');

  const [manifest, setManifest] = useState<{ pk_mod: string; signed_by: string; created_at: string } | null>(null);

  async function loadOrg() {
    if (!orgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await getOrg(orgId);
      setOrg(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadCurrentManifest() {
    if (!orgId) return;
    try {
      const m = await getEpochManifest(orgId, 'current');
      setManifest(m);
    } catch {
    }
  }

  useEffect(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    void loadOrg().then(() => {
      void loadCurrentManifest();
    });
  }, [orgId]);

  const handleRotate = useCallback(async () => {
    if (!orgId) return;
    setRotateLoading(true);
    setRotateError('');
    setRotateSuccess('');
    try {
      await rotateEpoch(orgId);
      setRotateSuccess('Epoch rotation initiated successfully');
      await loadOrg();
    } catch (err) {
      setRotateError((err as Error).message);
    } finally {
      setRotateLoading(false);
    }
  }, [orgId]);

  if (dashLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Epochs</h1>
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <p className="text-sm text-wv-dim">Loading…</p>
        </div>
      </div>
    );
  }

  if (!isLeader) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Epochs</h1>
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <p className="text-sm text-wv-amber">Epochs is leader-only.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Epochs</h1>
        </header>
        <p className="text-sm text-wv-dim">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Epochs</h1>
        </header>
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{error}</div>
      </div>
    );
  }

  if (!orgId) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Epochs</h1>
        </header>
        <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
          No organization selected. Please select an organization first.
        </div>
      </div>
    );
  }

  const rotationPending = org?.rotation_status === 'rotation_pending';
  const currentEpoch = org?.current_epoch ?? 0;

  const historyEpochs: EpochHistoryEntry[] = [];
  for (let i = 0; i < currentEpoch; i++) {
    historyEpochs.push({
      epoch_id: i,
      pk_mod: '',
      signed_by: '',
      created_at: '',
    });
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Epochs</h1>
        <p className="text-sm text-wv-dim">
          Monitor and manage epoch rotation for this organization.
        </p>
      </header>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Current Epoch</h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
            <dt className="text-xs font-mono font-semibold uppercase tracking-[0.08em] text-wv-dim">Epoch ID</dt>
            <dd data-testid="epoch-current-id" className="mt-1 text-2xl font-bold font-mono text-wv-text">{currentEpoch}</dd>
          </div>
          <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
            <dt className="text-xs font-mono font-semibold uppercase tracking-[0.08em] text-wv-dim">Rotation Status</dt>
            <dd className="mt-1">
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                rotationPending ? 'bg-[rgba(255,178,85,0.12)] text-wv-amber' : 'bg-[rgba(54,211,153,0.12)] text-wv-green'
              }`}>
                {rotationPending ? 'Pending' : 'Normal'}
              </span>
            </dd>
          </div>
          {manifest && (
            <>
              <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
                <dt className="text-xs font-mono font-semibold uppercase tracking-[0.08em] text-wv-dim">Mod Pubkey (current)</dt>
                <dd className="mt-1 font-mono text-sm text-wv-text break-all">{manifest.pk_mod.slice(0, 24)}…</dd>
              </div>
              <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
                <dt className="text-xs font-mono font-semibold uppercase tracking-[0.08em] text-wv-dim">Signed By</dt>
                <dd className="mt-1 font-mono text-sm text-wv-text break-all">{manifest.signed_by.slice(0, 16)}…</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      {rotationPending && (
        <section data-testid="epoch-rotation-warning" className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 shadow-wv-sm">
          <div className="flex items-start gap-3">
            <div>
              <h2 className="text-lg font-semibold text-wv-amber">Rotation Pending</h2>
              <p className="mt-1 text-sm text-wv-amber">
                This organization has a pending epoch rotation. Initiate the rotation process to advance to the next epoch.
              </p>
              {rotateError && (
                <div className="mt-3 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{rotateError}</div>
              )}
              {rotateSuccess && (
                <div className="mt-3 rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">{rotateSuccess}</div>
              )}
              <button
                data-testid="epoch-rotate-button"
                type="button"
                onClick={() => void handleRotate()}
                disabled={rotateLoading}
                className="mt-4 inline-flex items-center justify-center rounded-lg bg-wv-amber px-4 py-2 text-sm font-medium text-wv-bg shadow-wv-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[rgba(255,178,85,0.4)]"
              >
                {rotateLoading ? 'Rotating…' : 'Initiate Rotation'}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Epoch History</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Past epochs and their manifest details.
        </p>

        {historyEpochs.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No epoch history yet.</p>
        ) : (
          <div data-testid="epoch-history" className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-wv-line text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-wv-dim">Epoch ID</th>
                  <th className="px-3 py-2 text-left font-semibold text-wv-dim">Mod Pubkey</th>
                  <th className="px-3 py-2 text-left font-semibold text-wv-dim">Signed By</th>
                  <th className="px-3 py-2 text-left font-semibold text-wv-dim">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wv-line">
                {historyEpochs.map(epoch => (
                  <tr key={epoch.epoch_id}>
                    <td className="px-3 py-2 font-mono font-medium text-wv-text">{epoch.epoch_id}</td>
                    <td className="px-3 py-2 font-mono text-xs text-wv-dim truncate max-w-xs">{epoch.pk_mod || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-wv-dim truncate max-w-xs">{epoch.signed_by || '—'}</td>
                    <td className="px-3 py-2 text-wv-dim">
                      {epoch.created_at ? <ClientTime value={epoch.created_at} mode="date" /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
