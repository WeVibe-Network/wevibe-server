'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TxMsgData } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { ErrorBanner, LoadingState } from '@/components/ui/states';
import { buildRegisterOrgMsg, directBroadcast } from '@/lib/chain-client';
import { getConfig } from '@/lib/config';
import { classifyError, type ErrorKind } from '@/lib/errors';
import { discoverOrgs, getHubServingAddress, recordOrg } from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';
import { SLOT_CAP, slotBarHeightPercent, slotPriceUvibe, uvibeToVibe } from '@/lib/org-pricing';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';
import { useDashboardState } from '@/lib/use-dashboard-state';
import { connectWallet } from '@/lib/wallet-connect';
import { createGuestIdentity, setWalletAddress } from '@/lib/wevibe-auth';
import { buildOrgSetup } from '@/lib/wevibe-crypto';

const vibeFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const REGISTER_ORG_STORAGE_QUOTA = 1000;
const REGISTER_ORG_RETRIEVAL_BUDGET = 500;
const MSG_REGISTER_ORG_RESPONSE_TYPE_URL = '/wevibe.org.v1.MsgRegisterOrgResponse';
const CREATE_CONFIRM_POLL_ATTEMPTS = 30;
const CREATE_CONFIRM_POLL_INTERVAL_MS = 1000;

type ChartBarState = 'sold' | 'current' | 'future';

const AXIS_TICK_SLOTS = new Set([0, 7, 15, 23, SLOT_CAP - 1]);

function readVarint(bytes: Uint8Array, startOffset: number): { value: number; nextOffset: number } {
  let offset = startOffset;
  let value = 0;
  let shift = 0;

  while (offset < bytes.length) {
    const byte = bytes[offset];
    value |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }

    shift += 7;
    if (shift > 28) {
      throw new Error('MsgRegisterOrgResponse varint is too large');
    }
  }

  throw new Error('Unexpected EOF while decoding MsgRegisterOrgResponse');
}

function decodeRegisterOrgResponseOrgId(responseBytes: Uint8Array): string {
  let offset = 0;

  while (offset < responseBytes.length) {
    const tag = readVarint(responseBytes, offset);
    offset = tag.nextOffset;

    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const length = readVarint(responseBytes, offset);
      offset = length.nextOffset;
      const endOffset = offset + length.value;
      if (endOffset > responseBytes.length) {
        throw new Error('Invalid MsgRegisterOrgResponse org_id length');
      }
      return new TextDecoder().decode(responseBytes.slice(offset, endOffset));
    }

    if (wireType === 0) {
      const skip = readVarint(responseBytes, offset);
      offset = skip.nextOffset;
      continue;
    }

    if (wireType === 2) {
      const length = readVarint(responseBytes, offset);
      offset = length.nextOffset + length.value;
      if (offset > responseBytes.length) {
        throw new Error('Invalid MsgRegisterOrgResponse field length');
      }
      continue;
    }

    throw new Error(`Unsupported MsgRegisterOrgResponse wire type: ${wireType}`);
  }

  throw new Error('MsgRegisterOrgResponse missing org_id');
}

function extractOrgIdFromDeliverTxData(deliverTxData?: Uint8Array): string {
  if (!deliverTxData || deliverTxData.length === 0) {
    throw new Error('DeliverTx data missing; cannot decode MsgRegisterOrgResponse');
  }

  const txMsgData = TxMsgData.decode(deliverTxData);
  const registerOrgResponse = txMsgData.msgResponses.find(
    (response) => response.typeUrl === MSG_REGISTER_ORG_RESPONSE_TYPE_URL,
  );

  if (!registerOrgResponse) {
    throw new Error('MsgRegisterOrgResponse missing in DeliverTx msgResponses');
  }

  return decodeRegisterOrgResponseOrgId(registerOrgResponse.value);
}

function formatVibe(uvibe: number): string {
  return `${vibeFormatter.format(uvibeToVibe(uvibe))} VIBE`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const { state, walletAddress, walletLinked, identity, refresh } = useDashboardState();
  const { refresh: refreshOrgs } = useOrgContext();

  const [creatingIdentity, setCreatingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [currentSlot, setCurrentSlot] = useState(0);
  const [slotLoading, setSlotLoading] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [domain, setDomain] = useState('');
  const [showFaucetPrompt, setShowFaucetPrompt] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const canBuyOrgFlow = state !== 'INITIALIZING' && state !== 'NO_IDENTITY' && walletLinked;

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
    if (!canBuyOrgFlow) {
      return;
    }
    void loadCurrentSlot();
  }, [canBuyOrgFlow, loadCurrentSlot]);

  const capReached = currentSlot >= SLOT_CAP;
  const currentPriceUvibe = capReached ? null : slotPriceUvibe(currentSlot);
  const nextPriceUvibe = capReached || currentSlot + 1 >= SLOT_CAP
    ? null
    : slotPriceUvibe(currentSlot + 1);

  const chartSlots = useMemo(() => Array.from({ length: SLOT_CAP }, (_, index) => index), []);

  const chartBars = useMemo(() => {
    return chartSlots.map((slot) => {
      const heightPercent = slotBarHeightPercent(slot);
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

  const handleCreateIdentity = useCallback(async () => {
    setCreatingIdentity(true);
    setIdentityError(null);

    try {
      await createGuestIdentity();
      refresh();
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingIdentity(false);
    }
  }, [refresh]);

  const handleLinkWallet = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);

    try {
      const conn = await connectWallet('keplr');
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
      const validationToastId = txToast('Create org');
      txError(validationToastId, 'Org Name is required.');
      return;
    }

    if (!domainValue) {
      const validationToastId = txToast('Create org');
      txError(validationToastId, 'Domain of Expertise is required.');
      return;
    }

    if (!identity || !walletAddress) {
      const validationToastId = txToast('Create org');
      txError(validationToastId, 'No dashboard identity/wallet found. Connect wallet and try again.');
      return;
    }

    const toastId = txToast('Create org');

    setSubmitting(true);
    setShowFaucetPrompt(false);

    try {
      const walletConn = await connectWallet('keplr');
      if (walletConn.address !== walletAddress) {
        throw new Error('Connected wallet does not match dashboard wallet. Reconnect wallet and try again.');
      }

      const hubServingKey = await getHubServingAddress();

      const setup = await buildOrgSetup({
        orgName: orgNameValue,
        domain: domainValue,
        leaderEd25519PubHex: identity.pubkeyHex,
        leaderWallet: walletAddress,
      });

      const registerOrgMsg = buildRegisterOrgMsg(
        walletConn.address,
        setup.payload.leader_pubkey,
        REGISTER_ORG_STORAGE_QUOTA,
        REGISTER_ORG_RETRIEVAL_BUDGET,
        setup.payload.domain,
        hubServingKey,
        setup.payload.leader_wallet,
      );

      const broadcastResult = await directBroadcast(walletConn.address, [registerOrgMsg]);
      if (!broadcastResult.txHash) {
        throw new Error('Chain broadcast succeeded but tx_hash was missing');
      }

      const orgId = extractOrgIdFromDeliverTxData(broadcastResult.deliverTxData);

      await recordOrg({
        org_id: orgId,
        tx_hash: broadcastResult.txHash,
        leader_pubkey: setup.payload.leader_pubkey,
        leader_x25519_pubkey: setup.payload.leader_x25519_pubkey,
        leader_wallet: setup.payload.leader_wallet,
        org_name: setup.payload.org_name,
        domain: setup.payload.domain,
        fee_model: setup.payload.fee_model,
        enc_envelope: setup.payload.enc_envelope,
        search_envelope: setup.payload.search_envelope,
        mod_envelope: setup.payload.mod_envelope,
        pk_mod: setup.payload.pk_mod,
        signature: setup.payload.signature,
        hub_serving_key: hubServingKey,
      });

      await refreshOrgs(orgId);

      txConfirming(toastId, 'Create org');

      const chainRest = getConfig().chainRest;
      let confirmed = false;

      for (let attempt = 0; attempt < CREATE_CONFIRM_POLL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          await sleep(CREATE_CONFIRM_POLL_INTERVAL_MS);
        }

        try {
          const res = await fetch(`${chainRest}/wevibe/org/v1/org/${encodeURIComponent(orgId)}`);
          if (res.ok) {
            confirmed = true;
            break;
          }
        } catch {
          // Keep polling; chain confirmation may still arrive.
        }
      }

      setConfirmOpen(false);
      setOrgName('');
      setDomain('');
      void loadCurrentSlot();

      if (confirmed) {
        txSuccess(toastId, `Organization created: ${orgId}`);
        router.push('/my-org');
      } else {
        txError(toastId, 'Created, but on-chain confirmation is taking longer than expected — refresh shortly.');
      }
    } catch (err) {
      const kind = classifyError(err);
      const fallbackMessage = err instanceof Error ? err.message : String(err);

      if (kind === 'needs_gas') {
        setShowFaucetPrompt(true);
      }

      txError(toastId, errorToastMessage(kind, fallbackMessage));
    } finally {
      setSubmitting(false);
    }
  }, [capReached, domain, identity, loadCurrentSlot, orgName, refreshOrgs, router, submitting, walletAddress]);

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
      <Link
        href="/create-org"
        aria-label="Back to org chooser"
        className="inline-flex w-fit items-center gap-1 text-sm text-wv-dim transition-colors hover:text-wv-text"
      >
        <span aria-hidden>←</span>
        <span>Back</span>
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-wv-text">Buy An Org</h1>
        <p className="max-w-3xl text-sm text-wv-dim">
          Organization slots are scarce and priced on an ascending ladder. Each slot costs more than the last.
        </p>
      </header>

      {state === 'INITIALIZING' && (
        <LoadingState label="Loading org purchase flow…" rows={4} />
      )}

      {state === 'NO_IDENTITY' && (
        <Card className="p-6">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-wv-dim">
              Create a guest identity first to access organization purchase flows.
            </p>
            {identityError && <ErrorBanner>{identityError}</ErrorBanner>}
            <div className="flex items-center gap-3">
              <Button type="button" onClick={handleCreateIdentity} disabled={creatingIdentity}>
                {creatingIdentity ? 'Creating…' : 'Create Identity'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {state !== 'INITIALIZING' && state !== 'NO_IDENTITY' && !walletLinked && (
        <Card className="p-6">
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-wv-text">Link a wallet to create an org</h2>
            <p className="text-sm text-wv-dim">
              Org leaders sign on-chain, so a linked wallet is required.
            </p>
            {connectError && <ErrorBanner>{connectError}</ErrorBanner>}
            <div className="flex items-center gap-3">
              <Button type="button" onClick={handleLinkWallet} disabled={connecting}>
                {connecting ? 'Linking…' : 'Link Wallet'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {canBuyOrgFlow && (
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
                <div className="flex h-56 items-end gap-px">
                  {chartBars.map(({ slot, stateValue, heightPercent }) => (
                    <div
                      key={slot}
                      className={`min-w-0 flex-1 rounded-t-sm border transition-all ${barStyles(stateValue)}`}
                      style={{ height: `${heightPercent}%` }}
                      title={`Slot ${slot + 1}`}
                    />
                  ))}
                </div>
                <div className="mt-1 flex gap-px">
                  {chartBars.map(({ slot, stateValue }) => (
                    <span
                      key={slot}
                      className={`min-w-0 flex-1 text-center font-mono text-[10px] leading-none ${stateValue === 'current' ? 'text-wv-amber' : 'text-wv-dim opacity-70'}`}
                    >
                      {stateValue === 'current' || AXIS_TICK_SLOTS.has(slot) ? slot + 1 : ''}
                    </span>
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
                    Identity: a permanent, leader-independent slot (org_id like <span className="font-mono">wevibe-org-7</span>). It survives leadership transfer and resale.
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

      {canBuyOrgFlow && confirmOpen && (
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
