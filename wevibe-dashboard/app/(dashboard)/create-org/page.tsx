'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import Button from '@/components/ui/button';
import Card from '@/components/ui/card';
import { ErrorBanner, GuardCard, LoadingState } from '@/components/ui/states';
import InfoTooltip from '@/components/ui/tooltip';
import { IdentityOnboarding } from '@/components/onboarding/identity-onboarding';
import { useDashboardState } from '@/lib/use-dashboard-state';
import { useOrgContext } from '@/lib/org-context';
import { connectWallet } from '@/lib/wallet-connect';
import { setWalletAddress } from '@/lib/wevibe-auth';

const ONE_ORG_GATE_COPY = 'Only one organization per account is allowed.';

export default function CreateOrgPage() {
  const { state, walletLinked, refresh } = useDashboardState();
  const { orgs } = useOrgContext();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const leaderOrg = useMemo(
    () => orgs.find((org) => org.role === 'leader') ?? null,
    [orgs],
  );
  const canUseOrgFlow = state !== 'INITIALIZING' && state !== 'NO_IDENTITY' && walletLinked;
  const showJoinCreateChooser = canUseOrgFlow && !leaderOrg;

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

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-wv-text">Create Organization</h1>
        <p className="text-sm text-wv-dim">
          Choose whether to join an existing organization or buy a new organization slot.
        </p>
      </header>

      {state === 'INITIALIZING' && (
        <LoadingState label="Loading…" />
      )}

      {state === 'NO_IDENTITY' && (
        <IdentityOnboarding onReady={refresh} />
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

      {canUseOrgFlow && leaderOrg && (
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
    </div>
  );
}
