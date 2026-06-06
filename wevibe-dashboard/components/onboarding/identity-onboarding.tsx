'use client';

import { useCallback, useState } from 'react';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { ErrorBanner } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';
import {
  adoptIdentityFromPasskey,
  createGuestIdentity,
  importIdentityFromPhrase,
} from '@/lib/wevibe-auth';

type BusyAction = 'create' | 'adopt' | 'import' | null;

export function IdentityOnboarding({ onReady }: { onReady: () => void | Promise<void> }) {
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPhrase, setShowPhrase] = useState(false);
  const [phrase, setPhrase] = useState('');

  const runAction = useCallback(async (
    action: Exclude<BusyAction, null>,
    task: () => Promise<{ pubkeyHex: string }>,
  ) => {
    setBusy(action);
    setError(null);

    try {
      await task();
      await onReady();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [onReady]);

  const handleCreate = useCallback(async () => {
    await runAction('create', createGuestIdentity);
  }, [runAction]);

  const handleAdopt = useCallback(async () => {
    await runAction('adopt', adoptIdentityFromPasskey);
  }, [runAction]);

  const handleImport = useCallback(async () => {
    const trimmedPhrase = phrase.trim();
    if (!trimmedPhrase) {
      setError('Recovery phrase is required.');
      return;
    }

    await runAction('import', () => importIdentityFromPhrase(trimmedPhrase));
  }, [phrase, runAction]);

  const disabled = busy !== null;

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-wv-text">Set up your WeVibe identity</h2>
        <p className="text-sm text-wv-dim">
          Your identity key is protected by a passkey, so you can get started without linking a wallet.
        </p>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <div className="flex flex-col gap-3">
          <Button type="button" onClick={handleCreate} disabled={disabled}>
            {busy === 'create' ? 'Creating…' : 'Create identity'}
          </Button>

          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={handleAdopt} disabled={disabled}>
              {busy === 'adopt' ? 'Recovering…' : 'Use existing passkey'}
            </Button>
            <InfoTooltip label="Recover with an existing passkey">
              Already created a WeVibe identity on another device with a synced passkey? Recover it here with one tap.
            </InfoTooltip>
          </div>

          <div className="flex flex-col gap-3 pt-1">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="text-sm font-medium text-wv-violet hover:opacity-90 disabled:opacity-50"
                onClick={() => setShowPhrase((prev) => !prev)}
                disabled={disabled}
              >
                I have a recovery phrase
              </button>
              <InfoTooltip label="Restore with a recovery phrase">
                Restore from your 24-word recovery phrase if you don't have your passkey.
              </InfoTooltip>
            </div>

            {showPhrase && (
              <div className="flex flex-col gap-3 rounded-lg border border-wv-line bg-wv-panel-2 p-3">
                <textarea
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-wv-line-2 bg-wv-panel px-3 py-2 text-sm text-wv-text placeholder:text-wv-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(124,92,255,0.35)]"
                  placeholder="Enter your 24-word recovery phrase"
                  disabled={disabled}
                />
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleImport}
                    disabled={disabled || phrase.trim().length === 0}
                  >
                    {busy === 'import' ? 'Restoring…' : 'Restore'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
