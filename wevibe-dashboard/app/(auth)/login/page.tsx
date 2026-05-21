'use client';

import { useState, useEffect } from 'react';
import { getOrCreateIdentity, exportIdentity, importIdentity } from '@/lib/wevibe-auth';

export default function LoginPage() {
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState(false);
  const [importJson, setImportJson] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const result = await getOrCreateIdentity();
        setPubkeyHex(result.pubkeyHex);
        setIsNew(result.isNew);
      } catch (e) {
        setError(`Failed to initialize identity: ${(e as Error).message}`);
      }
    })();
  }, []);

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

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="rounded-lg border border-red-300 bg-red-50 p-8 max-w-lg">
          <h1 className="text-lg font-semibold text-red-800">Error</h1>
          <p className="mt-2 text-red-700">{error}</p>
          <p className="mt-4 text-sm text-red-600">
            Ed25519 WebCrypto requires Chrome 137+, Firefox 130+, or Safari 17+.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="rounded-lg border p-8 max-w-lg w-full">
        <h1 className="text-xl font-semibold">WeVibe Dashboard Identity</h1>

        {pubkeyHex ? (
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-500">Your Dashboard Public Key</label>
              <code className="mt-1 block break-all rounded bg-gray-100 p-3 text-sm font-mono">
                {pubkeyHex}
              </code>
            </div>

            {isNew && (
              <div className="rounded border-l-4 border-yellow-400 bg-yellow-50 p-4">
                <p className="text-sm text-yellow-800">
                  <strong>New key generated.</strong> Ask your org leader to register this public key
                  using the <code className="text-xs">wevibe_register_dashboard_key</code> MCP tool, or provide
                  it to them directly.
                </p>
              </div>
            )}

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

            <a
              href="/"
              className="block mt-4 rounded bg-black px-4 py-2 text-center text-sm text-white hover:bg-gray-800"
            >
              Continue to Dashboard
            </a>
          </div>
        ) : (
          <p className="mt-4 text-gray-500">Generating identity...</p>
        )}
      </div>
    </div>
  );
}