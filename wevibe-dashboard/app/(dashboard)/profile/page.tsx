'use client';

import { useEffect, useState } from 'react';
import { getIdentity } from '@/lib/wevibe-auth';
import { getProfile, type ProfileResponse } from '@/lib/hub-client';
import ClientTime from '@/components/ui/client-time';

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProfile() {
      const identity = await getIdentity();
      if (!identity) {
        setError('No identity found. Generate an identity first.');
        setLoading(false);
        return;
      }

      try {
        const data = await getProfile(identity.pubkeyHex);
        setProfile(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void loadProfile();
  }, []);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-wv-panel-2" />
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-wv-line bg-wv-panel" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {error}
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg border border-wv-line px-4 py-6 text-center text-sm text-wv-dim">
          Profile not found.
        </div>
      </div>
    );
  }

  const truncateAddress = (addr: string) => {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(profile.wallet);
  };

  const roleBadge = (role: string) => {
    switch (role) {
      case 'leader':
        return 'border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.14)] text-wv-violet';
      case 'moderator':
        return 'border border-wv-cyan bg-[rgba(52,220,240,0.12)] text-wv-cyan';
      default:
        return 'border border-wv-line bg-wv-panel-2 text-wv-dim';
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-wv-dim">Your WeVibe Network identity and stats.</p>
      </header>

      <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Identity</h2>
            {profile.display_name && (
              <p className="mt-1 text-sm font-medium text-wv-text">{profile.display_name}</p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded bg-wv-panel-2 px-2 py-1 text-sm font-mono text-wv-text">
                {truncateAddress(profile.wallet)}
              </code>
              <button
                onClick={copyAddress}
                className="text-xs text-wv-violet hover:text-wv-text"
              >
                Copy
              </button>
            </div>
            {profile.pubkey && (
              <p className="mt-1 text-xs font-mono text-wv-dim">
                Pubkey: {profile.pubkey.slice(0, 8)}...{profile.pubkey.slice(-4)}
              </p>
            )}
          </div>
        </div>
      </div>

      {profile.memberships && profile.memberships.length > 0 && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Organizations</h2>
          <div className="mt-4 space-y-3">
            {profile.memberships.map(membership => (
              <div
                key={membership.org_id}
                className="flex items-center justify-between rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3"
              >
                <div>
                  <p className="font-medium text-wv-text">{membership.org_name}</p>
                  <p className="text-xs font-mono text-wv-dim">
                    Joined <ClientTime value={membership.joined_at} mode="date" />
                  </p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-medium ${roleBadge(membership.role)}`}>
                  {membership.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {profile.chain_stats && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Contribution Stats</h2>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.chain_stats.total_approved_memories}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Approved Memories</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.chain_stats.total_serves}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Total Serves</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                Epoch {profile.chain_stats.first_seen_epoch}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">First Seen</p>
            </div>
          </div>
          {profile.chain_stats.reputation_tier && (
            <div className="mt-4">
              <span className="rounded-full border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.14)] px-3 py-1 text-sm font-medium text-wv-violet">
                Reputation: {profile.chain_stats.reputation_tier}
              </span>
            </div>
          )}
        </div>
      )}

      {profile.moderator_stats && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Moderator Activity</h2>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.moderator_stats.total_approvals}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Total Approvals</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.moderator_stats.total_upheld_reports}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Upheld Reports</p>
            </div>
          </div>
        </div>
      )}

      {profile.leader_stats && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <h2 className="text-lg font-semibold text-wv-text">Leader Activity</h2>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.leader_stats.total_chain_commits}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Chain Commits</p>
            </div>
            <div className="rounded-lg bg-wv-panel-2 px-4 py-3 text-center">
              <p className="text-2xl font-semibold text-wv-text">
                {profile.leader_stats.total_epoch_rotations}
              </p>
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-wv-dim">Epoch Rotations</p>
            </div>
          </div>
        </div>
      )}

      {!profile.chain_stats && !profile.moderator_stats && !profile.leader_stats && (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel p-6 text-center text-sm text-wv-dim">
          No on-chain activity yet.
        </div>
      )}
    </div>
  );
}
