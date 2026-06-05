'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useIdentity } from '@/lib/identity-context';
import { useOrgContext } from '@/lib/org-context';
import { formatVibe } from '@/lib/format';
import { getBalance, getOrg, getOrgFinances, type OrgFinances, type OrgSummary } from '@/lib/hub-client';
import type { OrgRole } from '@/lib/org-role';
import { getContributorStats, type ContributorStats } from '@/lib/social-graph-client';

type OrgSummaryWithMemberCount = OrgSummary & { member_count?: number };

function rolePillClass(role: OrgRole): string {
  switch (role) {
    case 'leader':
      return 'border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.12)] text-wv-violet';
    case 'moderator':
      return 'border-[rgba(52,220,240,0.4)] bg-[rgba(52,220,240,0.12)] text-wv-cyan';
    case 'contributor':
      return 'border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] text-wv-amber';
    default:
      return 'border-wv-line-2 bg-wv-panel-2 text-wv-dim';
  }
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function HeroValue({ loading, value, className }: { loading: boolean; value: string; className: string }) {
  if (loading) {
    return <div className="h-12 w-28 animate-pulse rounded-lg bg-wv-panel" />;
  }
  return <p className={className}>{value}</p>;
}

function LeaderTile({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div className="rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3">
      {loading ? (
        <div className="h-7 w-20 animate-pulse rounded bg-wv-panel" />
      ) : (
        <p className="text-xl font-semibold text-wv-text">{value}</p>
      )}
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-wv-dim">{label}</p>
    </div>
  );
}

export default function MyOrgPage() {
  const router = useRouter();
  const { activeOrg, loading: orgLoading } = useOrgContext();
  const { identity, walletAddress, loading: identityLoading } = useIdentity();

  const [stats, setStats] = useState<ContributorStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [vibeBalance, setVibeBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const [orgSummary, setOrgSummary] = useState<OrgSummaryWithMemberCount | null>(null);
  const [orgSummaryLoading, setOrgSummaryLoading] = useState(false);

  const [orgFinances, setOrgFinances] = useState<OrgFinances | null>(null);
  const [orgFinancesLoading, setOrgFinancesLoading] = useState(false);

  useEffect(() => {
    if (!identityLoading && !identity) {
      router.push('/login');
    }
  }, [identityLoading, identity, router]);

  const identityPubkey = identity?.pubkeyHex ?? null;
  const activeOrgId = activeOrg?.org_id ?? null;
  const activeOrgRole = activeOrg?.role ?? null;

  useEffect(() => {
    if (!identityPubkey || orgLoading || !activeOrgId || !activeOrgRole) {
      return;
    }

    let active = true;

    setStatsLoading(true);
    setStats(null);
    void getContributorStats(identityPubkey)
      .then(result => {
        if (!active) return;
        setStats(result);
      })
      .catch(() => {
        if (!active) return;
        setStats(null);
      })
      .finally(() => {
        if (!active) return;
        setStatsLoading(false);
      });

    if (walletAddress) {
      setBalanceLoading(true);
      setVibeBalance(null);
      void getBalance(walletAddress)
        .then(result => {
          if (!active) return;
          setVibeBalance(formatVibe(result.amount));
        })
        .catch(() => {
          if (!active) return;
          setVibeBalance('—');
        })
        .finally(() => {
          if (!active) return;
          setBalanceLoading(false);
        });
    } else {
      setBalanceLoading(false);
      setVibeBalance('—');
    }

    setOrgSummaryLoading(true);
    setOrgSummary(null);
    void getOrg(activeOrgId)
      .then(result => {
        if (!active) return;
        setOrgSummary(result as OrgSummaryWithMemberCount);
      })
      .catch(() => {
        if (!active) return;
        setOrgSummary(null);
      })
      .finally(() => {
        if (!active) return;
        setOrgSummaryLoading(false);
      });

    if (activeOrgRole === 'leader') {
      setOrgFinancesLoading(true);
      setOrgFinances(null);
      void getOrgFinances(activeOrgId)
        .then(result => {
          if (!active) return;
          setOrgFinances(result);
        })
        .catch(() => {
          if (!active) return;
          setOrgFinances(null);
        })
        .finally(() => {
          if (!active) return;
          setOrgFinancesLoading(false);
        });
    } else {
      setOrgFinancesLoading(false);
      setOrgFinances(null);
    }

    return () => {
      active = false;
    };
  }, [identityPubkey, walletAddress, orgLoading, activeOrgId, activeOrgRole]);

  if (identityLoading) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <div className="space-y-2">
          <div className="h-3 w-20 animate-pulse rounded bg-wv-panel-2" />
          <div className="h-10 w-64 animate-pulse rounded bg-wv-panel-2" />
        </div>
        <div className="rounded-2xl border border-[rgba(124,92,255,0.28)] bg-wv-panel-2 p-6">
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map(item => (
              <div key={item} className="space-y-2">
                <div className="h-12 w-28 animate-pulse rounded bg-wv-panel" />
                <div className="h-3 w-24 animate-pulse rounded bg-wv-panel" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!identity) {
    return null;
  }

  if (orgLoading) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <div className="space-y-2">
          <div className="h-3 w-20 animate-pulse rounded bg-wv-panel-2" />
          <div className="h-10 w-64 animate-pulse rounded bg-wv-panel-2" />
        </div>
        <div className="rounded-2xl border border-[rgba(124,92,255,0.28)] bg-wv-panel-2 p-6">
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map(item => (
              <div key={item} className="space-y-2">
                <div className="h-12 w-28 animate-pulse rounded bg-wv-panel" />
                <div className="h-3 w-24 animate-pulse rounded bg-wv-panel" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!activeOrg) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-6">
        <header className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-wv-faint">MY ORG</p>
          <h1 className="text-2xl font-semibold text-wv-text">You&apos;re not in an org yet</h1>
          <p className="text-sm text-wv-dim">Join an existing org or create your own to start building reputation.</p>
        </header>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/discover"
            className="rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
          >
            Discover Orgs
          </Link>
          <Link
            href="/create-org"
            className="rounded-lg border border-[rgba(124,92,255,0.32)] bg-[rgba(124,92,255,0.14)] px-4 py-2 text-sm font-medium text-wv-violet transition hover:opacity-95"
          >
            Create Org
          </Link>
        </div>
      </div>
    );
  }

  const contributions = stats?.contributions ?? 0;
  const serves = stats?.serves ?? 0;
  const reputationXp = stats?.reputation_xp ?? 0;
  const firstSeenEpoch = stats?.first_seen_epoch ?? 0;
  const orgBreadth = stats?.org_breadth ?? 0;

  const members = orgSummary?.member_count ?? 0;
  const currentEpoch = orgSummary?.current_epoch ?? activeOrg.current_epoch;
  const orgStatus = orgSummary?.status ?? '—';
  const hubCredits = orgFinances?.hub_credits ?? 0;
  const chainTreasury = orgFinances?.chain_treasury ?? 0;
  const orgDomain = orgSummary?.domain ?? '—';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 pb-6">
      <header className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-wv-faint">MY ORG</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-wv-text">{activeOrg.org_name}</h1>
          <span
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] ${rolePillClass(
              activeOrg.role,
            )}`}
          >
            {activeOrg.role}
          </span>
        </div>
      </header>

      <section className="rounded-xl border border-wv-line bg-wv-panel p-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-wv-faint">ORG IDENTITY</p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-[rgba(124,92,255,0.32)] bg-[rgba(124,92,255,0.1)] p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-wv-violet">ORG ID (canonical)</p>
            <p className="mt-2 break-all font-mono text-base text-wv-text">{activeOrg.org_id}</p>
            <p className="mt-2 text-xs text-wv-dim">
              Source-of-truth identifier for this organization (anti-impersonation check).
            </p>
          </div>
          <div className="rounded-lg border border-wv-line bg-wv-panel-2 p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-wv-dim">Domain of Expertise</p>
            {orgSummaryLoading ? (
              <div className="mt-2 h-6 w-40 animate-pulse rounded bg-wv-panel" />
            ) : (
              <p className="mt-2 text-sm text-wv-text">{orgDomain}</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[rgba(124,92,255,0.28)] bg-wv-panel-2 p-6 shadow-[0_0_40px_rgba(124,92,255,0.16)]">
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <HeroValue
              loading={statsLoading}
              value={formatCount(contributions)}
              className="text-4xl font-semibold text-wv-text"
            />
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-wv-dim">CONTRIBUTIONS</p>
          </div>

          <div>
            <HeroValue
              loading={statsLoading}
              value={formatCount(serves)}
              className="text-4xl font-semibold text-wv-amber"
            />
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-wv-dim">SERVES</p>
            <p className="mt-1 text-xs text-wv-faint">times your memory was used</p>
          </div>

          <div>
            <HeroValue
              loading={statsLoading}
              value={formatCount(reputationXp)}
              className="text-4xl font-semibold text-wv-cyan"
            />
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-wv-dim">REPUTATION XP</p>
          </div>

          <div>
            <HeroValue
              loading={balanceLoading}
              value={vibeBalance ?? '—'}
              className="text-4xl font-semibold text-wv-amber"
            />
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-wv-dim">VIBE BALANCE</p>
          </div>
        </div>
        {firstSeenEpoch > 0 && (
          <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.1em] text-wv-faint">
            first seen epoch {firstSeenEpoch} · {orgBreadth} org{orgBreadth === 1 ? '' : 's'}
          </p>
        )}
      </section>

      {activeOrg.role === 'leader' && (
        <section className="rounded-xl border border-wv-line bg-wv-panel p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-wv-faint">ORG</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <LeaderTile label="MEMBERS" value={formatCount(members)} loading={orgSummaryLoading} />
            <LeaderTile label="EPOCH" value={formatCount(currentEpoch)} loading={orgSummaryLoading} />
            <LeaderTile label="STATUS" value={orgStatus} loading={orgSummaryLoading} />
            <LeaderTile label="HUB CREDITS" value={formatCount(hubCredits)} loading={orgFinancesLoading} />
            <LeaderTile label="CHAIN TREASURY" value={formatCount(chainTreasury)} loading={orgFinancesLoading} />
          </div>
        </section>
      )}
    </div>
  );
}
