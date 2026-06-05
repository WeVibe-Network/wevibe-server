'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { ErrorBanner, GuardCard, LoadingState } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';
import { classifyError } from '@/lib/errors';
import { createOrg } from '@/lib/hub-client';
import { useDashboardState } from '@/lib/use-dashboard-state';
import { useOrgContext } from '@/lib/org-context';
import { connectWallet } from '@/lib/wallet-connect';
import { createGuestIdentity, setWalletAddress } from '@/lib/wevibe-auth';
import { buildOrgSetup } from '@/lib/wevibe-crypto';

const ONE_ORG_GATE_COPY = 'Only one organization per account is allowed.';
const ONE_ORG_GATE_ERROR = 'You already own an organization. Only one organization per account is allowed.';

interface CreateOrgSuccessState {
  orgId: string;
  orgName: string;
  recoveryPhrase: string;
}

function isLeaderOwnershipConflict(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 409) {
      return true;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return normalized.includes('409')
    || normalized.includes('already owns')
    || normalized.includes('already own')
    || (normalized.includes('one org') && normalized.includes('account'));
}

export default function CreateOrgPage() {
  const router = useRouter();
  const { state, walletAddress, walletLinked, identity, refresh } = useDashboardState();
  const { orgs } = useOrgContext();
  const [orgName, setOrgName] = useState('');
  const [domain, setDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [creatingIdentity, setCreatingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitConflictMessage, setSubmitConflictMessage] = useState<string | null>(null);
  const [showFaucetPrompt, setShowFaucetPrompt] = useState(false);
  const [success, setSuccess] = useState<CreateOrgSuccessState | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const leaderOrg = useMemo(
    () => orgs.find((org) => org.role === 'leader') ?? null,
    [orgs],
  );
  const canUseOrgFlow = state !== 'INITIALIZING' && state !== 'NO_IDENTITY' && walletLinked;
  const showJoinCreateChooser = state === 'IDENTITY_NO_ORG' && walletLinked && !success && !leaderOrg;

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

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitConflictMessage(null);
    setShowFaucetPrompt(false);
    setSuccess(null);

    if (!identity || !walletAddress) {
      setSubmitError('No dashboard identity/wallet found. Log in again before creating an organization.');
      return;
    }

    const orgNameValue = orgName.trim();
    const domainValue = domain.trim();

    if (!orgNameValue) {
      setSubmitError('Org Name is required');
      return;
    }
    if (!domainValue) {
      setSubmitError('Domain of Expertise is required');
      return;
    }

    setSubmitting(true);

    try {
      const setup = await buildOrgSetup({
        orgName: orgNameValue,
        domain: domainValue,
        leaderEd25519PubHex: identity.pubkeyHex,
        leaderWallet: walletAddress,
      });
      const created = await createOrg(setup.payload);

      setSuccess({
        orgId: created.org_id,
        orgName: orgNameValue,
        recoveryPhrase: setup.recoveryPhrase,
      });
      setCopyStatus('idle');
    } catch (err) {
      const errorKind = classifyError(err);

      if (errorKind === 'needs_gas') {
        setShowFaucetPrompt(true);
      } else if (errorKind === 'conflict' || isLeaderOwnershipConflict(err)) {
        setSubmitConflictMessage(
          leaderOrg
            ? `You already own an organization: ${leaderOrg.org_name}. ${ONE_ORG_GATE_COPY}`
            : ONE_ORG_GATE_ERROR,
        );
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }, [domain, identity, leaderOrg, orgName, walletAddress]);

  const handleCopyPhrase = useCallback(async () => {
    if (!success?.recoveryPhrase) {
      return;
    }

    try {
      await navigator.clipboard.writeText(success.recoveryPhrase);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }, [success]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-wv-text">Create Organization</h1>
        <p className="text-sm text-wv-dim">
          Register a real organization through the WeVibe hub. You become the leader for this org.
        </p>
      </header>

      {state === 'INITIALIZING' && (
        <LoadingState label="Loading…" />
      )}

      {state === 'NO_IDENTITY' && (
        <Card className="p-6">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-wv-dim">
              Create a guest identity first to access dashboard organization flows.
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

      {canUseOrgFlow && success && (
        <Card className="p-6">
          <div className="flex flex-col gap-5">
            <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] p-4">
              <p className="text-sm font-semibold text-wv-green">Organization created successfully</p>
              <p className="mt-2 text-sm text-wv-text">
                Save this recovery phrase now. It is shown ONCE and is the ONLY way to recover your
                organization&apos;s master key. WeVibe cannot recover it for you.
              </p>
              <code className="mt-3 block break-words rounded-md border border-wv-line bg-wv-panel-2 p-3 font-mono text-sm leading-6 text-wv-text">
                {success.recoveryPhrase}
              </code>
              <div className="mt-3 flex items-center gap-3">
                <Button type="button" variant="secondary" onClick={handleCopyPhrase}>
                  Copy
                </Button>
                {copyStatus === 'copied' && <span className="text-xs text-wv-green">Recovery phrase copied.</span>}
                {copyStatus === 'failed' && (
                  <span className="text-xs text-wv-red">Copy failed. Please copy it manually.</span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-wv-line bg-wv-panel-2 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">New organization</p>
              <p className="mt-2 text-sm text-wv-text">{success.orgName}</p>
              <p className="mt-1 font-mono text-sm text-wv-text">{success.orgId}</p>
              <Link
                href={`/discover/${success.orgId}`}
                className="mt-3 inline-flex text-sm font-medium text-wv-violet hover:opacity-90"
              >
                View organization details
              </Link>
            </div>

            <div className="flex items-center gap-3">
              <Button type="button" onClick={() => router.push('/')}>
                Continue to dashboard
              </Button>
            </div>
          </div>
        </Card>
      )}

      {canUseOrgFlow && !success && leaderOrg && (
        <Card className="p-6">
          <GuardCard title={`You already own an organization: ${leaderOrg.org_name}`}>
            <p className="mt-2 text-sm text-wv-text">{ONE_ORG_GATE_COPY}</p>
            <Link
              href={`/discover/${leaderOrg.org_id}`}
              className="mt-3 inline-flex text-sm font-medium text-wv-violet hover:opacity-90"
            >
              View organization details
            </Link>
          </GuardCard>
        </Card>
      )}

      {showJoinCreateChooser && (
        <div className="grid gap-4 md:grid-cols-2">
          <Link href="/discover" className="group">
            <Card className="h-full border-wv-line transition group-hover:border-[rgba(52,220,240,0.45)] group-hover:shadow-wv-md">
              <div className="flex h-full flex-col gap-4 p-6">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-xl font-semibold text-wv-text">Join Org</h2>
                  <InfoTooltip label="Who should join an organization">
                    Join an existing organization, collaborate with leaders and moderators, and contribute memories to
                    an established domain.
                  </InfoTooltip>
                </div>
                <p className="text-sm font-medium text-wv-cyan">For contributors.</p>
                <p className="text-sm text-wv-dim">
                  Browse existing organizations, pick your domain, and request to join.
                </p>
                <span className="mt-auto text-sm font-medium text-wv-violet">Go to Discover →</span>
              </div>
            </Card>
          </Link>

          <Link href="/buy-org" className="group">
            <Card className="h-full border-[rgba(255,178,85,0.32)] transition group-hover:border-[rgba(255,178,85,0.55)] group-hover:shadow-wv-md">
              <div className="flex h-full flex-col gap-4 p-6">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-xl font-semibold text-wv-text">Create Org</h2>
                  <InfoTooltip label="Who should create an organization">
                    Buy a scarce organization slot, become the accountable leader, and build a curated knowledge org
                    for your domain.
                  </InfoTooltip>
                </div>
                <p className="text-sm font-medium text-wv-amber">For domain experts — become a leader.</p>
                <p className="text-sm text-wv-dim">
                  Purchase an org slot, set your domain focus, and start leading contributors.
                </p>
                <span className="mt-auto text-sm font-medium text-wv-amber">Go to Buy An Org →</span>
              </div>
            </Card>
          </Link>
        </div>
      )}

      {canUseOrgFlow && state !== 'IDENTITY_NO_ORG' && !success && !leaderOrg && (
        <form onSubmit={handleSubmit} data-testid="create-org-form" className="flex flex-col gap-5">
          <Card className="p-6">
            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor="org-name" className="block text-sm font-medium text-wv-text">
                  Org Name
                </label>
                <input
                  id="org-name"
                  data-testid="org-name-input"
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="My Organization"
                  className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="domain" className="block text-sm font-medium text-wv-text">
                  Domain of Expertise
                </label>
                <input
                  id="domain"
                  data-testid="domain-input"
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="e.g. React, Next.js, TypeScript"
                  className="mt-1 w-full rounded-[11px] border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none"
                />
                <p className="mt-1 text-xs text-wv-dim">
                  What your org specializes in — this is how contributors discover and decide to join you. Be
                  specific about your stack or field.
                </p>
              </div>
            </div>
          </Card>

          {submitConflictMessage && (
            <GuardCard title={submitConflictMessage} />
          )}

          {showFaucetPrompt && (
            <div className="rounded-lg border border-[rgba(52,220,240,0.4)] bg-[rgba(52,220,240,0.12)] px-3 py-2 text-sm text-wv-cyan">
              Wallet gas is required to create an organization.{' '}
              <Link href="/faucet" className="font-medium text-wv-violet hover:opacity-90">
                Top up in Faucet
              </Link>
              .
            </div>
          )}

          {submitError && (
            <div data-testid="error-display">
              <ErrorBanner>{submitError}</ErrorBanner>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" data-testid="submit-button" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Organization'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
