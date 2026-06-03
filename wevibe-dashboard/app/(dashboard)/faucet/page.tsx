'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { fundFromFaucet, type FaucetFundResponse } from '@/lib/hub-client';
import { getWalletAddress } from '@/lib/wevibe-auth';

const DEFAULT_AMOUNT = 1_000_000;

function truncateAddress(address: string): string {
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

export default function FaucetPage() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [amountInput, setAmountInput] = useState(String(DEFAULT_AMOUNT));
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<FaucetFundResponse | null>(null);

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

    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setSuccess(null);
      setError('Amount (uvibe) must be a positive number.');
      return;
    }

    setRequesting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fundFromFaucet(walletAddress, amount);
      setSuccess(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
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
              <div>
                <label htmlFor="faucet-amount" className="block text-sm font-medium text-wv-text">
                  Amount (uvibe)
                </label>
                <input
                  id="faucet-amount"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={amountInput}
                  onChange={event => setAmountInput(event.target.value)}
                  className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 font-mono text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={requesting}>
                  {requesting ? 'Requesting…' : 'Request Funds'}
                </Button>
              </div>

              {success && (
                <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-2 text-sm text-wv-green">
                  Funded <span className="font-mono">{success.amount.toLocaleString()}</span> uvibe to{' '}
                  <span className="font-mono">{truncateAddress(success.address)}</span> ({success.status}).
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
