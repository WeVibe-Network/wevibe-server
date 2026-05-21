'use client';
import { useCallback, useEffect, useState } from 'react';
import { getOrg, getEpochManifest, rotateEpoch, type OrgSummary } from '@/lib/hub-client';

const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID ?? '';

interface EpochHistoryEntry {
  epoch_id: number;
  pk_mod: string;
  signed_by: string;
  created_at: string;
}

export default function EpochPage() {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rotateSuccess, setRotateSuccess] = useState('');

  const [manifest, setManifest] = useState<{ pk_mod: string; signed_by: string; created_at: string } | null>(null);

  async function loadOrg() {
    setLoading(true);
    setError('');
    try {
      const data = await getOrg(ORG_ID);
      setOrg(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadCurrentManifest() {
    if (!ORG_ID) return;
    try {
      const m = await getEpochManifest(ORG_ID, 'current');
      setManifest(m);
    } catch {
    }
  }

  useEffect(() => {
    if (!ORG_ID) {
      setLoading(false);
      return;
    }
    void loadOrg().then(() => {
      void loadCurrentManifest();
    });
  }, []);

  const handleRotate = useCallback(async () => {
    setRotateLoading(true);
    setRotateError('');
    setRotateSuccess('');
    try {
      await rotateEpoch(ORG_ID);
      setRotateSuccess('Epoch rotation initiated successfully');
      await loadOrg();
    } catch (err) {
      setRotateError((err as Error).message);
    } finally {
      setRotateLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Epochs</h1>
        </header>
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Epochs</h1>
        </header>
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
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
        <p className="text-sm text-zinc-500">
          Monitor and manage epoch rotation for this organization.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Current Epoch</h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-4 py-3">
            <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Epoch ID</dt>
            <dd data-testid="epoch-current-id" className="mt-1 text-2xl font-bold text-zinc-900">{currentEpoch}</dd>
          </div>
          <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-4 py-3">
            <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Rotation Status</dt>
            <dd className="mt-1">
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                rotationPending ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
              }`}>
                {rotationPending ? 'Pending' : 'Normal'}
              </span>
            </dd>
          </div>
          {manifest && (
            <>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-4 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Mod Pubkey (current)</dt>
                <dd className="mt-1 font-mono text-sm text-zinc-700 break-all">{manifest.pk_mod.slice(0, 24)}…</dd>
              </div>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-4 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Signed By</dt>
                <dd className="mt-1 font-mono text-sm text-zinc-700 break-all">{manifest.signed_by.slice(0, 16)}…</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      {rotationPending && (
        <section data-testid="epoch-rotation-warning" className="rounded-xl border border-amber-200 bg-amber-50/70 p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div>
              <h2 className="text-lg font-semibold text-amber-900">Rotation Pending</h2>
              <p className="mt-1 text-sm text-amber-700">
                This organization has a pending epoch rotation. Initiate the rotation process to advance to the next epoch.
              </p>
              {rotateError && (
                <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{rotateError}</div>
              )}
              {rotateSuccess && (
                <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{rotateSuccess}</div>
              )}
              <button
                data-testid="epoch-rotate-button"
                type="button"
                onClick={() => void handleRotate()}
                disabled={rotateLoading}
                className="mt-4 inline-flex items-center justify-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-amber-300"
              >
                {rotateLoading ? 'Rotating…' : 'Initiate Rotation'}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-200 bg-white/70 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">Epoch History</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Past epochs and their manifest details.
        </p>

        {historyEpochs.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No epoch history yet.</p>
        ) : (
          <div data-testid="epoch-history" className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Epoch ID</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Mod Pubkey</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Signed By</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-700">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {historyEpochs.map(epoch => (
                  <tr key={epoch.epoch_id}>
                    <td className="px-3 py-2 font-medium text-zinc-900">{epoch.epoch_id}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-600 truncate max-w-xs">{epoch.pk_mod || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-600 truncate max-w-xs">{epoch.signed_by || '—'}</td>
                    <td className="px-3 py-2 text-zinc-500">
                      {epoch.created_at ? new Date(epoch.created_at).toLocaleDateString() : '—'}
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