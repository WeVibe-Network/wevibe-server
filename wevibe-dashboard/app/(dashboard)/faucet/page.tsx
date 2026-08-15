'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { fundFromFaucet, getBalance, type FaucetFundResponse } from '@/lib/hub-client';
import { formatVibeWithDenom } from '@/lib/format';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';
import { getWalletAddress } from '@/lib/wevibe-auth';

const FAUCET_AMOUNT_VIBE = 10000;
const FAUCET_AMOUNT_UVIBE = 10_000_000_000;
const CONFIRMATION_POLL_INTERVAL_MS = 2_000;
const CONFIRMATION_POLL_ATTEMPTS = 15;

type FaucetPhase = 'idle' | 'submitting' | 'confirming' | 'done' | 'error';
type FaucetOutcome = 'confirmed' | 'pending_confirmation' | null;

function truncateAddress(address: string): string {
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default function FaucetPage() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [phase, setPhase] = useState<FaucetPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<FaucetFundResponse | null>(null);
  const [outcome, setOutcome] = useState<FaucetOutcome>(null);
  const [confirmedDeltaUvibe, setConfirmedDeltaUvibe] = useState<string | null>(null);

  const requesting = phase === 'submitting' || phase === 'confirming';

  useEffect(() => {
    let cancelled = false;

    void getWalletAddress()
      .then(addr => {
        if (!cancelled) {
          setWalletAddress(addr);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWalletAddress(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWalletLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!walletAddress) {
      return;
    }

    setPhase('submitting');
    setError(null);
    setSuccess(null);
    setOutcome(null);
    setConfirmedDeltaUvibe(null);

    let beforeBalance = BigInt(0);
    try {
      const before = await getBalance(walletAddress);
      beforeBalance = BigInt(before.amount);
    } catch {
      beforeBalance = BigInt(0);
    }

    const toastId = txToast('Faucet');

    let response: FaucetFundResponse;

    try {
      response = await fundFromFaucet(walletAddress, FAUCET_AMOUNT_UVIBE);
    } catch (err) {
      txError(toastId, 'Faucet request failed');
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setPhase('confirming');
    txConfirming(toastId, 'Faucet');

    let confirmedBalance: bigint | null = null;
    for (let attempt = 0; attempt < CONFIRMATION_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(CONFIRMATION_POLL_INTERVAL_MS);
      }

      try {
        const current = await getBalance(walletAddress);
        const currentBalance = BigInt(current.amount);
        if (currentBalance > beforeBalance) {
          confirmedBalance = currentBalance;
          break;
        }
      } catch {
        // Continue polling; submission succeeded and confirmation may still arrive.
      }
    }

    setSuccess(response);
    setPhase('done');

    if (confirmedBalance != null) {
      const confirmedDelta = confirmedBalance - beforeBalance;
      const confirmedDeltaString = confirmedDelta.toString();
      setOutcome('confirmed');
      setConfirmedDeltaUvibe(confirmedDeltaString);
      txSuccess(toastId, `Funded ${formatVibeWithDenom(confirmedDeltaString)} — confirmed`);
      return;
    }

    setOutcome('pending_confirmation');
    txError(toastId, 'Submitted, but confirmation is taking longer than expected — check your balance shortly.');
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-wv-text">Faucet</h1>
        <p className="text-sm text-wv-dim">
          Testnet faucet — funds your wallet with VIBE for gas. Ungated during testing.
        </p>
      </header>

      {!walletLoaded && (
        <Card className="p-6">
          <p className="text-sm text-wv-dim">Loading connected wallet…</p>
        </Card>
      )}

      {walletLoaded && !walletAddress && (
        <Card className="p-6">
          <p className="text-sm text-wv-dim">No connected wallet identity found.</p>
          <p className="mt-2 text-sm text-wv-dim">Connect your wallet to request faucet funds.</p>
          <Link href="/login" className="mt-4 inline-flex text-sm font-medium text-wv-violet hover:opacity-90">
            Go to login
          </Link>
        </Card>
      )}

      {walletAddress && (
        <Card className="p-6">
          <div className="space-y-5">
            <div className="rounded-md border border-wv-line bg-wv-panel-2 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Connected wallet</p>
              <p className="mt-1 font-mono text-sm text-wv-text">{truncateAddress(walletAddress)}</p>
              <code className="mt-3 block break-all rounded-md border border-wv-line bg-wv-panel px-3 py-2 font-mono text-xs text-wv-text">
                {walletAddress}
              </code>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="rounded-md border border-wv-line bg-wv-panel-2 p-4">
                <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">You will receive</p>
                <p className="mt-1 font-mono text-lg text-wv-text">{FAUCET_AMOUNT_VIBE} VIBE</p>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={requesting}>
                  {phase === 'submitting' ? 'Submitting…' : phase === 'confirming' ? 'Confirming…' : `Request ${FAUCET_AMOUNT_VIBE} VIBE`}
                </Button>
              </div>

              {(phase === 'submitting' || phase === 'confirming') && (
                <div className="flex items-center gap-2 text-sm text-wv-dim">
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-wv-line border-t-wv-violet"
                  />
                  <span>{phase === 'submitting' ? 'Submitting…' : 'Confirming on chain…'}</span>
                </div>
              )}

              {success && outcome === 'confirmed' && (
                <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">
                  Funded <span className="font-mono">{formatVibeWithDenom(confirmedDeltaUvibe ?? String(success.amount))}</span>{' '}
                  to <span className="font-mono">{truncateAddress(success.address)}</span>
                </div>
              )}

              {success && outcome === 'pending_confirmation' && (
                <div className="rounded-lg border border-[rgba(251,191,36,0.45)] bg-[rgba(251,191,36,0.12)] px-3 py-2 text-sm text-[rgba(251,191,36,0.95)]">
                  Submitted faucet request for <span className="font-mono">{formatVibeWithDenom(String(FAUCET_AMOUNT_UVIBE))}</span> to{' '}
                  <span className="font-mono">{truncateAddress(success.address)}</span>, but confirmation is taking longer than
                  expected. Check your balance shortly.
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
                  {error}
                </div>
              )}
            </form>
          </div>
        </Card>
      )}
    </div>
  );
}
