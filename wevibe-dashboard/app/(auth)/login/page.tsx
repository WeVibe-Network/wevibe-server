'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  detectWallets,
  connectWallet,
  getChainConfig,
  type WalletProvider,
} from '@/lib/wallet-connect';
import {
  deriveIdentityFromWallet,
  getIdentity,
  setWalletAddress,
  exportIdentity,
  importIdentity,
} from '@/lib/wevibe-auth';

export default function LoginPage() {
  const router = useRouter();
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<WalletProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [checkingIdentity, setCheckingIdentity] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState(false);
  const [importJson, setImportJson] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const identity = await getIdentity();
        if (!mounted) return;

        if (identity) {
          setPubkeyHex(identity.pubkeyHex);
        } else {
          setAvailableWallets(detectWallets());
        }
      } catch (e) {
        if (!mounted) return;
        setError(`Failed to initialize identity: ${(e as Error).message}`);
      } finally {
        if (mounted) {
          setCheckingIdentity(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const handleConnect = async (provider: WalletProvider) => {
    setLoading(true);
    setError(null);
    try {
      const conn = await connectWallet(provider);
      const walletApi = provider === 'keplr' ? window.keplr : window.leap;
      if (!walletApi) {
        throw new Error(`${provider} wallet not available after connection`);
      }

      const chainId = getChainConfig().chainId;
      const identity = await deriveIdentityFromWallet(walletApi, chainId, conn.address);
      await setWalletAddress(conn.address);
      setPubkeyHex(identity.pubkeyHex);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    const exported = await exportIdentity();
    if (!exported) return;
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wevibe-dashboard-key.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async () => {
    try {
      const parsed = JSON.parse(importJson);
      const newPubkey = await importIdentity(parsed.publicKeyJwk, parsed.privateKeyJwk);
      setPubkeyHex(newPubkey);
      setImportMode(false);
      setImportJson('');
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-lg rounded-lg border border-wv-line bg-wv-panel p-8 shadow-wv-sm">
        <h1 className="text-xl font-semibold text-wv-text">WeVibe Dashboard Identity</h1>

        {error && (
          <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] p-3 text-sm text-wv-red">
            {error}
          </div>
        )}

        {pubkeyHex ? (
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-mono uppercase tracking-[0.08em] text-wv-dim">Your Dashboard Public Key</label>
              <code className="mt-1 block break-all rounded-lg border border-wv-line bg-wv-panel-2 p-3 text-sm font-mono text-wv-text">
                {pubkeyHex}
              </code>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleExport}
                className="rounded-lg border border-wv-line-2 bg-wv-panel-2 px-4 py-2 text-sm text-wv-text transition hover:bg-wv-line"
              >
                Export Key (for backup/migration)
              </button>
              <button
                onClick={() => setImportMode(!importMode)}
                className="rounded-lg border border-wv-line-2 bg-wv-panel-2 px-4 py-2 text-sm text-wv-text transition hover:bg-wv-line"
              >
                Import Key
              </button>
            </div>

            {importMode && (
              <div className="space-y-2">
                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder="Paste exported key JSON here..."
                  className="w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm font-mono text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                  rows={6}
                />
                <button
                  onClick={handleImport}
                  className="rounded-lg bg-wv-grad-btn px-4 py-2 text-sm text-white shadow-wv-sm transition hover:opacity-95"
                >
                  Import
                </button>
              </div>
            )}

            <button
              onClick={() => router.push('/')}
              className="mt-4 block rounded-lg bg-wv-grad-btn px-4 py-2 text-center text-sm text-white shadow-wv-sm transition hover:opacity-95"
            >
              Continue to Dashboard
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-wv-dim">Connect your wallet to derive your dashboard identity.</p>

            {checkingIdentity ? (
              <p className="text-wv-dim">Checking existing identity...</p>
            ) : availableWallets.length === 0 ? (
              <p className="text-wv-dim">Install Keplr or Leap wallet to continue</p>
            ) : (
              <div className="flex gap-2">
                {availableWallets.map((provider) => (
                  <button
                    key={provider}
                    onClick={() => handleConnect(provider)}
                    disabled={loading}
                    className="rounded-lg bg-wv-grad-btn px-4 py-2 text-sm text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {loading
                      ? 'Connecting...'
                      : provider === 'keplr'
                        ? 'Connect Keplr'
                        : 'Connect Leap'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
