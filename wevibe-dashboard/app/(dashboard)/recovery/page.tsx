'use client';
import { useCallback, useEffect, useState } from 'react';
import { getRecoveryShare, storeRecoveryShares, type RecoveryShareEntry } from '@/lib/hub-client';
import { getIdentity } from '@/lib/wevibe-auth';

const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID ?? '';

const MAX_SHARES = 3;

export default function RecoveryPage() {
  const [shares, setShares] = useState<RecoveryShareEntry[]>([]);
  const [storedCount, setStoredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [slot0, setSlot0] = useState('');
  const [slot1, setSlot1] = useState('');
  const [slot2, setSlot2] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  const [retrieveLoading, setRetrieveLoading] = useState(false);
  const [retrieveError, setRetrieveError] = useState('');
  const [retrievedShare, setRetrievedShare] = useState<{ share_index: number; sealed_share: string; holder_pubkey: string } | null>(null);

  async function loadShares() {
    setLoading(true);
    setError('');
    try {
      const identity = await getIdentity();
      if (!identity) {
        setError('No identity found');
        return;
      }
      const share = await getRecoveryShare(ORG_ID);
      if (share) {
        setRetrievedShare({
          share_index: share.share_index,
          sealed_share: share.sealed_share,
          holder_pubkey: identity.pubkeyHex,
        });
        setStoredCount(1);
        setShares([{
          share_index: share.share_index,
          holder_pubkey: identity.pubkeyHex,
          sealed_share: share.sealed_share,
        }]);
      } else {
        setStoredCount(0);
        setShares([]);
      }
    } catch (e) {
      if ((e as Error).message.includes('not found')) {
        setStoredCount(0);
        setShares([]);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!ORG_ID) {
      setLoading(false);
      return;
    }
    void loadShares();
  }, []);

  const handleSave = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveLoading(true);
    setSaveError('');
    setSaveSuccess('');
    try {
      const identity = await getIdentity();
      if (!identity) {
        setSaveError('No identity found');
        return;
      }
      const shareEntries: RecoveryShareEntry[] = [];
      const slots = [slot0, slot1, slot2];
      for (let i = 0; i < MAX_SHARES; i++) {
        if (slots[i].trim()) {
          shareEntries.push({
            share_index: i,
            holder_pubkey: identity.pubkeyHex,
            sealed_share: slots[i].trim(),
          });
        }
      }
      if (shareEntries.length === 0) {
        setSaveError('At least one share is required');
        return;
      }
      await storeRecoveryShares(ORG_ID, shareEntries);
      setSaveSuccess(`Stored ${shareEntries.length} share(s)`);
      setSlot0('');
      setSlot1('');
      setSlot2('');
      await loadShares();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaveLoading(false);
    }
  }, [slot0, slot1, slot2]);

  const handleRetrieve = useCallback(async () => {
    setRetrieveLoading(true);
    setRetrieveError('');
    setRetrievedShare(null);
    try {
      const identity = await getIdentity();
      if (!identity) {
        setRetrieveError('No identity found');
        return;
      }
      const share = await getRecoveryShare(ORG_ID);
      if (share) {
        setRetrievedShare({
          share_index: share.share_index,
          sealed_share: share.sealed_share,
          holder_pubkey: identity.pubkeyHex,
        });
      } else {
        setRetrieveError('No share found for your identity');
      }
    } catch (err) {
      setRetrieveError((err as Error).message);
    } finally {
      setRetrieveLoading(false);
    }
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Recovery Shares</h1>
        <p className="text-sm text-wv-dim">
          Shamir secret sharing for org key recovery. Store up to {MAX_SHARES} shares with trusted holders.
        </p>
      </header>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Stored Shares</h2>
        <p className="mt-1 text-sm text-wv-dim">
          {storedCount} of {MAX_SHARES} share slots filled.
        </p>

        {loading ? (
          <p className="mt-4 text-sm text-wv-dim">Loading…</p>
        ) : error ? (
          <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{error}</div>
        ) : storedCount === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No shares stored yet.</p>
        ) : (
          <div data-testid="recovery-share-display" className="mt-4 space-y-2">
            {shares.map(share => (
              <div key={share.share_index} className="flex items-center justify-between rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-2">
                <div>
                  <span className="text-xs font-mono font-semibold uppercase tracking-wide text-wv-dim">Share {share.share_index}</span>
                  <p className="mt-0.5 max-w-xs truncate font-mono text-sm text-wv-text">{share.holder_pubkey.slice(0, 16)}…</p>
                </div>
                <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">Stored</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Store Shares</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Enter up to {MAX_SHARES} sealed shares. Each share should come from your Shamir split operation.
        </p>

        <form onSubmit={handleSave} className="mt-4 space-y-3">
          <div>
            <label htmlFor="share-0" className="block text-sm font-medium text-wv-text">Share 0</label>
            <input
              data-testid="recovery-share-input-0"
              id="share-0"
              type="text"
              value={slot0}
              onChange={e => setSlot0(e.target.value)}
              placeholder="Sealed share for slot 0"
              className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text font-mono placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="share-1" className="block text-sm font-medium text-wv-text">Share 1</label>
            <input
              data-testid="recovery-share-input-1"
              id="share-1"
              type="text"
              value={slot1}
              onChange={e => setSlot1(e.target.value)}
              placeholder="Sealed share for slot 1"
              className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text font-mono placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="share-2" className="block text-sm font-medium text-wv-text">Share 2</label>
            <input
              data-testid="recovery-share-input-2"
              id="share-2"
              type="text"
              value={slot2}
              onChange={e => setSlot2(e.target.value)}
              placeholder="Sealed share for slot 2"
              className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text font-mono placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
            />
          </div>

          {saveError && (
            <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{saveError}</div>
          )}
          {saveSuccess && (
            <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">{saveSuccess}</div>
          )}

          <button
            data-testid="recovery-save-button"
            type="submit"
            disabled={saveLoading || (!slot0.trim() && !slot1.trim() && !slot2.trim())}
            className="inline-flex items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-line-2 disabled:text-wv-faint"
          >
            {saveLoading ? 'Saving…' : 'Save Shares'}
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <h2 className="text-lg font-semibold text-wv-text">Retrieve My Share</h2>
        <p className="mt-1 text-sm text-wv-dim">
          Retrieve the share that was sealed under your identity pubkey.
        </p>

        {retrieveError && (
          <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">{retrieveError}</div>
        )}

        {retrievedShare ? (
          <div data-testid="recovery-retrieved-share" className="mt-4 space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-2">
              <div>
                <span className="text-xs font-mono font-semibold uppercase tracking-wide text-wv-green">Share {retrievedShare.share_index}</span>
                <p className="mt-0.5 font-mono text-sm text-wv-text break-all">{retrievedShare.sealed_share}</p>
              </div>
            </div>
          </div>
        ) : (
          <button
            data-testid="recovery-retrieve-button"
            type="button"
            onClick={() => void handleRetrieve()}
            disabled={retrieveLoading}
            className="mt-4 inline-flex items-center justify-center rounded-lg border border-[rgba(124,92,255,0.4)] px-4 py-2 text-sm font-medium text-wv-violet transition hover:bg-[rgba(124,92,255,0.14)] disabled:cursor-not-allowed disabled:bg-wv-panel-2 disabled:text-wv-faint"
          >
            {retrieveLoading ? 'Retrieving…' : 'Retrieve My Share'}
          </button>
        )}
      </section>
    </div>
  );
}
