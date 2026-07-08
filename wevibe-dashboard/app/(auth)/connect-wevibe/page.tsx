'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Button from '@/components/ui/button';
import { ErrorBanner } from '@/components/ui/states';
import { adoptIdentityFromCode } from '@/lib/wevibe-auth';

type AdoptState = 'INIT' | 'NO_CODE' | 'ADOPTING' | 'DONE' | 'ERROR';

function getPairingCodeFromHash(hash: string): string | null {
  const trimmedHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmedHash) {
    return null;
  }

  const params = new URLSearchParams(trimmedHash);
  const fromParams = params.get('code')?.trim();
  if (fromParams) {
    return fromParams;
  }

  const codeIndex = trimmedHash.indexOf('code=');
  if (codeIndex < 0) {
    return null;
  }

  const rawCode = trimmedHash.slice(codeIndex + 'code='.length).split('&')[0] ?? '';
  try {
    const decoded = decodeURIComponent(rawCode).trim();
    return decoded || null;
  } catch {
    return rawCode.trim() || null;
  }
}

export default function AdoptPage() {
  const router = useRouter();
  const [state, setState] = useState<AdoptState>('INIT');
  const [manualCode, setManualCode] = useState('');
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAdoption = useCallback(async (token: string) => {
    setError(null);
    setState('ADOPTING');

    try {
      const result = await adoptIdentityFromCode(token);
      setPubkeyHex(result.pubkeyHex);
      setState('DONE');
    } catch (err) {
      setPubkeyHex(null);
      setError(err instanceof Error ? err.message : String(err));
      setState('ERROR');
    }
  }, []);

  useEffect(() => {
    const token = getPairingCodeFromHash(window.location.hash);
    history.replaceState(null, '', window.location.pathname);

    if (!token) {
      setState('NO_CODE');
      return;
    }

    setManualCode(token);
    void runAdoption(token);
  }, [runAdoption]);

  const handleManualSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = manualCode.trim();
    if (!token) {
      setError('Pairing code is required.');
      setState('NO_CODE');
      return;
    }

    void runAdoption(token);
  }, [manualCode, runAdoption]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-lg rounded-lg border border-wv-line bg-wv-panel p-8 shadow-wv-sm">
        <h1 className="text-xl font-semibold text-wv-text">WeVibe Dashboard Identity</h1>

        {state === 'INIT' && (
          <p className="mt-4 text-wv-dim">Preparing pairing…</p>
        )}

        {state === 'NO_CODE' && (
          <div className="mt-4 space-y-4">
            <p className="text-wv-dim">Open this page from your plugin&apos;s Go button, or paste your pairing code.</p>
            {error && <ErrorBanner>{error}</ErrorBanner>}

            <form onSubmit={handleManualSubmit} className="space-y-3">
              <input
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                className="w-full rounded-md border border-wv-line-2 bg-wv-panel px-3 py-2 text-sm text-wv-text placeholder:text-wv-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(124,92,255,0.35)]"
                placeholder="Paste pairing code"
                autoComplete="off"
              />
              <div>
                <Button type="submit" disabled={manualCode.trim().length === 0}>
                  Adopt
                </Button>
              </div>
            </form>
          </div>
        )}

        {state === 'ADOPTING' && (
          <p className="mt-4 text-wv-dim">Pairing…</p>
        )}

        {state === 'DONE' && pubkeyHex && (
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-mono uppercase tracking-[0.08em] text-wv-dim">Your Dashboard Public Key</label>
              <code className="mt-1 block break-all rounded-lg border border-wv-line bg-wv-panel-2 p-3 text-sm font-mono text-wv-text">
                {pubkeyHex}
              </code>
            </div>

            <Button type="button" onClick={() => router.push('/')}>
              Continue to Dashboard
            </Button>
          </div>
        )}

        {state === 'ERROR' && (
          <div className="mt-4 space-y-4">
            <ErrorBanner>{error ?? 'Failed to adopt identity from pairing code.'}</ErrorBanner>
            <Link href="/login" className="text-sm font-medium text-wv-violet hover:opacity-90">
              Back to login
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
