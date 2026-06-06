'use client';

import { useCallback, useMemo, useState } from 'react';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { ErrorBanner } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';
import { createPairingToken } from '@/lib/wevibe-auth';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PairPlugin() {
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);

  const command = useMemo(
    () => (token ? `node dist/admin.js pair --code ${token}` : ''),
    [token],
  );

  const handleGenerateCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTokenCopied(false);
    setCommandCopied(false);

    try {
      const { token: nextToken } = await createPairingToken();
      setToken(nextToken);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleCopyToken = useCallback(async () => {
    if (!token) {
      return;
    }

    try {
      await navigator.clipboard.writeText(token);
      setTokenCopied(true);
      setCommandCopied(false);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [token]);

  const handleCopyCommand = useCallback(async () => {
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      setCommandCopied(true);
      setTokenCopied(false);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [command]);

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}

        {!token && (
          <div>
            <Button type="button" onClick={handleGenerateCode} disabled={busy}>
              {busy ? 'Generating…' : 'Generate pairing code'}
            </Button>
          </div>
        )}

        {token && (
          <>
            <div className="rounded-lg border border-wv-line bg-wv-panel-2 p-3">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Pairing code</p>
              <code className="mt-2 block break-all font-mono text-sm leading-6 text-wv-text">{token}</code>
              <div className="mt-3 flex items-center gap-3">
                <Button type="button" variant="secondary" onClick={handleCopyToken}>
                  Copy
                </Button>
                {tokenCopied && <span className="text-xs text-wv-green">Copied.</span>}
              </div>
            </div>

            <div className="rounded-lg border border-wv-line bg-wv-panel-2 p-3">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Plugin command</p>
              <code className="mt-2 block break-all font-mono text-sm leading-6 text-wv-text">{command}</code>
              <div className="mt-3 flex items-center gap-3">
                <Button type="button" variant="secondary" onClick={handleCopyCommand}>
                  Copy
                </Button>
                {commandCopied && <span className="text-xs text-wv-green">Copied.</span>}
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs text-wv-dim">
              <p>Expires in 15 minutes · single use. Run this in your wevibe-mcp plugin directory.</p>
              <InfoTooltip label="How plugin pairing works">
                Pairing securely copies your identity to the plugin so it signs as the same key — no need to type your
                recovery phrase.
              </InfoTooltip>
            </div>

            <div>
              <Button type="button" variant="secondary" onClick={handleGenerateCode} disabled={busy}>
                {busy ? 'Generating…' : 'Generate a new code'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
