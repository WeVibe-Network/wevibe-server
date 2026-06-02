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
      <div className="rounded-lg border p-8 max-w-lg w-full">
        <h1 className="text-xl font-semibold">WeVibe Dashboard Identity</h1>

        {error && (
          <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {pubkeyHex ? (
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-500">Your Dashboard Public Key</label>
              <code className="mt-1 block break-all rounded bg-gray-100 p-3 text-sm font-mono">
                {pubkeyHex}
              </code>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleExport}
                className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300"
              >
                Export Key (for backup/migration)
              </button>
              <button
                onClick={() => setImportMode(!importMode)}
                className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300"
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
                  className="w-full rounded border p-2 text-sm font-mono"
                  rows={6}
                />
                <button
                  onClick={handleImport}
                  className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                >
                  Import
                </button>
              </div>
            )}

            <button
              onClick={() => router.push('/')}
              className="mt-4 block rounded bg-black px-4 py-2 text-center text-sm text-white hover:bg-gray-800"
            >
              Continue to Dashboard
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-gray-600">Connect your wallet to derive your dashboard identity.</p>

            {checkingIdentity ? (
              <p className="text-gray-500">Checking existing identity...</p>
            ) : availableWallets.length === 0 ? (
              <p className="text-gray-500">Install Keplr or Leap wallet to continue</p>
            ) : (
              <div className="flex gap-2">
                {availableWallets.map((provider) => (
                  <button
                    key={provider}
                    onClick={() => handleConnect(provider)}
                    disabled={loading}
                    className="rounded bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
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
