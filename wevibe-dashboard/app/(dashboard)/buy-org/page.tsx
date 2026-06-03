'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { ErrorBanner, LoadingState } from '@/components/ui/states';
import { classifyError, type ErrorKind } from '@/lib/errors';
import { createOrg, discoverOrgs } from '@/lib/hub-client';
import { SLOT_CAP, slotPriceUvibe, uvibeToVibe } from '@/lib/org-pricing';
import { useDashboardState } from '@/lib/use-dashboard-state';
import { connectWallet, getChainConfig } from '@/lib/wallet-connect';
import { deriveIdentityFromWallet, setWalletAddress } from '@/lib/wevibe-auth';
import { buildOrgSetup } from '@/lib/wevibe-crypto';

const vibeFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

type ChartBarState = 'sold' | 'current' | 'future';

function formatVibe(uvibe: number): string {
  return `${vibeFormatter.format(uvibeToVibe(uvibe))} VIBE`;
}

function errorToastMessage(kind: ErrorKind, fallbackMessage: string): string {
  switch (kind) {
    case 'conflict':
      return 'This wallet already owns an organization slot.';
    case 'forbidden':
      return 'You are not authorized to buy an organization from this session.';
    case 'network':
      return 'Network error while buying organization. Please retry.';
    default:
      return fallbackMessage;
  }
}

function barStyles(state: ChartBarState): string {
  switch (state) {
    case 'sold':
      return 'border-wv-line bg-wv-panel-3 opacity-45';
    case 'current':
      return 'border-[rgba(255,178,85,0.82)] bg-[rgba(255,178,85,0.28)] shadow-[0_0_30px_rgba(255,178,85,0.38)]';
    case 'future':
      return 'border-[rgba(124,92,255,0.3)] bg-[rgba(124,92,255,0.2)] opacity-70';
    default:
      return 'border-wv-line bg-wv-panel-2';
  }
}

export default function BuyOrgPage() {
  const router = useRouter();
  const { state, walletAddress, identity, refresh } = useDashboardState();

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [currentSlot, setCurrentSlot] = useState(0);
  const [slotLoading, setSlotLoading] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [domain, setDomain] = useState('');
  const [showFaucetPrompt, setShowFaucetPrompt] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isConnectedState = state !== 'INITIALIZING' && state !== 'NO_WALLET';

  const loadCurrentSlot = useCallback(async () => {
    setSlotLoading(true);
    try {
      const response = await discoverOrgs({ limit: 1, offset: 0 });
      const slotCount = typeof response.total === 'number'
        ? response.total
        : Array.isArray(response.orgs)
          ? response.orgs.length
          : 0;
      setCurrentSlot(Math.max(0, Math.floor(slotCount)));
    } catch {
      setCurrentSlot(0);
    } finally {
      setSlotLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isConnectedState) {
      return;
    }
    void loadCurrentSlot();
  }, [isConnectedState, loadCurrentSlot]);

  const capReached = currentSlot >= SLOT_CAP;
  const currentPriceUvibe = capReached ? null : slotPriceUvibe(currentSlot);
  const nextPriceUvibe = capReached || currentSlot + 1 >= SLOT_CAP
    ? null
    : slotPriceUvibe(currentSlot + 1);

  const chartSlots = useMemo(() => {
    const visible = Math.min(10, SLOT_CAP);
    const centeredStart = capReached
      ? SLOT_CAP - visible
      : currentSlot - Math.floor(visible / 2);
    const start = Math.max(0, Math.min(centeredStart, SLOT_CAP - visible));
    return Array.from({ length: visible }, (_, index) => start + index);
  }, [capReached, currentSlot]);

  const chartBars = useMemo(() => {
    const prices = chartSlots.map((slot) => slotPriceUvibe(slot));
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const spread = Math.max(maxPrice - minPrice, 1);

    return chartSlots.map((slot, index) => {
      const price = prices[index];
      const heightPercent = 24 + (((price - minPrice) / spread) * 76);
      const isCurrent = !capReached && slot === currentSlot;
      const isSold = capReached || slot < currentSlot;
      const stateValue: ChartBarState = isCurrent ? 'current' : isSold ? 'sold' : 'future';

      return {
        slot,
        stateValue,
        heightPercent,
      };
    });
  }, [capReached, chartSlots, currentSlot]);

  const handleConnectWallet = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);

    try {
      const conn = await connectWallet('keplr');
      const walletApi = window.keplr;
      if (!walletApi) {
        throw new Error('keplr wallet not available after connection');
      }

      const chainId = getChainConfig().chainId;
      await deriveIdentityFromWallet(walletApi, chainId, conn.address);
      await setWalletAddress(conn.address);
      refresh();
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

  const handleConfirmBuy = useCallback(async () => {
    if (submitting || capReached) {
      return;
    }

    const orgNameValue = orgName.trim();
    const domainValue = domain.trim();

    if (!orgNameValue) {
      toast.error('Org Name is required.', { position: 'top-right' });
      return;
    }

    if (!domainValue) {
      toast.error('Domain of Expertise is required.', { position: 'top-right' });
      return;
    }

    if (!identity || !walletAddress) {
      toast.error('No dashboard identity/wallet found. Connect wallet and try again.', { position: 'top-right' });
      return;
    }

    setSubmitting(true);
    setShowFaucetPrompt(false);

    try {
      const setup = await buildOrgSetup({
        orgName: orgNameValue,
        domain: domainValue,
        leaderEd25519PubHex: identity.pubkeyHex,
        leaderSeedHex: identity.seedHex,
        leaderWallet: walletAddress,
      });
      // TODO(phase-h): replace createOrg POST with CosmJS-direct MsgRegisterOrg broadcast
      const created = await createOrg(setup.payload);

      toast.success(`Organization purchased: ${created.org_id}`, { position: 'top-right' });
      setConfirmOpen(false);
      setOrgName('');
      setDomain('');
      void loadCurrentSlot();
      router.push(`/discover/${created.org_id}`);
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'needs_gas') {
        setShowFaucetPrompt(true);
      } else {
        const fallbackMessage = err instanceof Error ? err.message : String(err);
        toast.error(errorToastMessage(kind, fallbackMessage), { position: 'top-right' });
      }
    } finally {
      setSubmitting(false);
    }
  }, [capReached, domain, identity, loadCurrentSlot, orgName, router, submitting, walletAddress]);

  const openConfirmModal = useCallback(() => {
    if (capReached) {
      return;
    }
    setShowFaucetPrompt(false);
    setConfirmOpen(true);
  }, [capReached]);

  const currentPriceLabel = currentPriceUvibe == null ? 'All slots taken' : formatVibe(currentPriceUvibe);
  const nextPriceLabel = nextPriceUvibe == null ? 'N/A' : formatVibe(nextPriceUvibe);
  const buyButtonLabel = currentPriceUvibe == null
    ? 'All slots taken'
    : `Get Org — ${formatVibe(currentPriceUvibe)}`;
  const confirmButtonLabel = currentPriceUvibe == null
    ? 'Confirm & Buy'
    : `Confirm & Buy (${formatVibe(currentPriceUvibe)})`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-wv-text">Buy An Org</h1>
        <p className="max-w-3xl text-sm text-wv-dim">
          Organization slots are scarce and priced on an ascending ladder. Each slot costs more than the last.
        </p>
      </header>

      {state === 'INITIALIZING' && (
        <LoadingState label="Loading org purchase flow…" rows={4} />
      )}

      {state === 'NO_WALLET' && (
        <Card className="p-6">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-wv-dim">
              Connect your wallet to view slot pricing and buy an organization.
            </p>
            {connectError && <ErrorBanner>{connectError}</ErrorBanner>}
            <div className="flex items-center gap-3">
              <Button type="button" onClick={handleConnectWallet} disabled={connecting}>
                {connecting ? 'Connecting…' : 'Connect Wallet'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {isConnectedState && (
        <>
          <Card className="p-6">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-wv-text">Slot Price Ladder</h2>
                <span className="font-mono text-xs text-wv-dim">
                  {slotLoading ? 'Syncing slot index…' : `${currentSlot} already taken / ${SLOT_CAP} total`}
                </span>
              </div>

              <div className="rounded-lg border border-wv-line bg-wv-panel-2/70 p-4">
                <div className="flex h-56 items-end gap-2">
                  {chartBars.map(({ slot, stateValue, heightPercent }) => (
                    <div key={slot} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                      <div
                        className={`w-full rounded-t-sm border transition-all ${barStyles(stateValue)}`}
                        style={{ height: `${heightPercent}%` }}
                        title={`Slot ${slot + 1}`}
                      />
                      <span className={`font-mono text-[11px] ${stateValue === 'current' ? 'text-wv-amber' : 'text-wv-dim'}`}>
                        {slot + 1}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-wv-line pt-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-wv-dim">Slots</span>
                  <div className="flex items-center gap-3 text-[11px] text-wv-dim">
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-wv-panel-3" /> Sold</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[rgba(255,178,85,0.9)]" /> Current</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[rgba(124,92,255,0.6)]" /> Future</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4 rounded-lg border border-wv-line bg-wv-panel-2 p-4 md:flex-row md:items-end md:justify-between">
                <div className="grid gap-4 sm:grid-cols-2">
                  <p className="font-mono text-sm text-wv-text">
                    <span className="text-wv-dim">Current price:</span>{' '}
                    {currentPriceLabel}
                  </p>
                  <p className="font-mono text-sm text-wv-text">
                    <span className="text-wv-dim">Next price:</span>{' '}
                    {nextPriceLabel}
                  </p>
                </div>

                <Button
                  type="button"
                  onClick={openConfirmModal}
                  disabled={capReached || slotLoading}
                  className="border border-[rgba(255,178,85,0.5)] bg-[rgba(255,178,85,0.16)] text-wv-amber hover:bg-[rgba(255,178,85,0.24)]"
                  variant="secondary"
                >
                  {buyButtonLabel}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex flex-col gap-6">
              <h2 className="text-xl font-semibold text-wv-text">Details</h2>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-wv-amber">What you&apos;re buying</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-wv-dim">
                  <li>
                    Identity: a permanent, leader-independent slot (org_id like <span className="font-mono">weorg-7</span>). It survives leadership transfer and resale.
                  </li>
                  <li>
                    Scarcity: hard cap (32 in alpha, 320 testnet, 3200 mainnet) — slots are deliberately scarce.
                  </li>
                </ul>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-wv-amber">How the price works</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-wv-dim">
                  <li>Ascending: each new slot costs more than the last, so earlier is cheaper.</li>
                  <li>Split 50/50: half is burned (deflationary), half is deposited into your org&apos;s on-chain account as working capital.</li>
                </ul>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-wv-amber">Your responsibilities as leader</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-wv-dim">
                  <li>Curate and moderate your org&apos;s memories.</li>
                  <li>Fund your org&apos;s on-chain account (transaction gas + per-memory storage deposits).</li>
                  <li>Stay accountable: objective on-chain rules apply now; malice leads to slot forfeiture and slashed deposits redistributed to those harmed. (A self-assessed value + rent comes later.)</li>
                </ul>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-wv-amber">Benefits</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-wv-dim">
                  <li>Own and lead a curated memory organization.</li>
                  <li>A public, well-funded org account signals credibility.</li>
                  <li>Build reputation; later, earn from the membership demand-leg.</li>
                </ul>
              </section>
            </div>
          </Card>
        </>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-wv-bg/80 px-4 py-6">
          <Card className="max-h-[92vh] w-full max-w-2xl overflow-y-auto p-6">
            <div className="flex flex-col gap-5">
              <h2 className="text-xl font-semibold text-wv-text">You&apos;re about to buy an organization — read carefully.</h2>

              <section className="rounded-lg border border-[rgba(255,178,85,0.38)] bg-[rgba(255,178,85,0.1)] p-4">
                <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-wv-amber">Rewards</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-wv-text">
                  <li>A permanent, resellable organization slot — your own curated knowledge org (only 32 exist in alpha; scarce).</li>
                  <li>A public on-chain org account, seeded with half of what you pay — a visible fundedness/credibility signal to attract members &amp; contributors.</li>
                  <li>You lead contributors, curate memories, and (later) earn from members paying for recall.</li>
                </ul>
              </section>

              <section className="rounded-lg border border-[rgba(255,107,107,0.38)] bg-[rgba(255,107,107,0.1)] p-4">
                <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-wv-red">Risks — read carefully</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-wv-text">
                  <li>This costs VIBE. Half is BURNED forever; half seeds your org&apos;s on-chain account.</li>
                  <li>You become the accountable LEADER. Negligent or malicious leadership can cost you the org — the slot can be forfeited and re-auctioned, and deposits slashed to those harmed.</li>
                  <li>You pay ongoing costs: transaction gas and a storage deposit for each memory your org commits.</li>
                </ul>
              </section>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="buy-org-name" className="block text-sm font-medium text-wv-text">
                    Org Name
                  </label>
                  <input
                    id="buy-org-name"
                    type="text"
                    value={orgName}
                    onChange={(event) => setOrgName(event.target.value)}
                    placeholder="My Organization"
                    className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="buy-org-domain" className="block text-sm font-medium text-wv-text">
                    Domain of Expertise
                  </label>
                  <input
                    id="buy-org-domain"
                    type="text"
                    value={domain}
                    onChange={(event) => setDomain(event.target.value)}
                    placeholder="e.g. React, Next.js, TypeScript"
                    className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-wv-dim">This is your expertise domain, not a DNS host. Example: &ldquo;React, Next.js, TypeScript&rdquo;.</p>
                </div>
              </div>

              {showFaucetPrompt && (
                <div className="rounded-lg border border-[rgba(52,220,240,0.4)] bg-[rgba(52,220,240,0.12)] px-3 py-2 text-sm text-wv-cyan">
                  Wallet gas is required to create an organization.{' '}
                  <Link href="/faucet" className="font-medium text-wv-violet hover:opacity-90">
                    Top up in Faucet
                  </Link>
                  .
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirmOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirmBuy}
                  disabled={submitting || capReached}
                  className="border border-[rgba(255,178,85,0.5)] bg-[rgba(255,178,85,0.16)] text-wv-amber hover:bg-[rgba(255,178,85,0.24)]"
                  variant="secondary"
                >
                  {submitting && <span className="mr-2 inline-flex h-4 w-4 animate-spin rounded-full border-2 border-wv-amber border-r-transparent" />}
                  {submitting ? 'Submitting…' : confirmButtonLabel}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
