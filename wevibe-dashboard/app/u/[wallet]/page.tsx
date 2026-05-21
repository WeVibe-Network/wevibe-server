import { getProfile, type ProfileResponse } from '@/lib/hub-client';

interface PageProps {
  params: { wallet: string };
}

export default async function PublicProfilePage({ params }: PageProps) {
  const wallet = decodeURIComponent(params.wallet);

  let profile: ProfileResponse | null = null;
  let error: string | null = null;

  try {
    profile = await getProfile(wallet);
  } catch (err) {
    error = (err as Error).message;
  }

  const truncateAddress = (addr: string) => {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  };

  const roleBadge = (role: string) => {
    switch (role) {
      case 'leader':
        return 'bg-purple-100 text-purple-700';
      case 'moderator':
        return 'bg-blue-100 text-blue-700';
      default:
        return 'bg-gray-100 text-gray-600';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl space-y-6 py-8 px-4">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
          <p className="text-sm text-zinc-500">Public on-chain identity</p>
        </header>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {!profile && !error && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-center">
            <p className="text-sm text-gray-500">Loading...</p>
          </div>
        )}

        {profile && (
          <>
            <div className="rounded-xl border border-gray-200 bg-white p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Identity</h2>
                  {profile.display_name && (
                    <p className="mt-1 text-sm font-medium text-gray-700">{profile.display_name}</p>
                  )}
                  <div className="mt-2">
                    <code className="rounded bg-gray-100 px-2 py-1 text-sm font-mono text-gray-700">
                      {truncateAddress(profile.wallet)}
                    </code>
                  </div>
                  {profile.pubkey && (
                    <p className="mt-1 text-xs text-gray-500">
                      Pubkey: {profile.pubkey.slice(0, 8)}...{profile.pubkey.slice(-4)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {profile.memberships && profile.memberships.length > 0 && (
              <div className="rounded-xl border border-gray-200 bg-white p-6">
                <h2 className="text-lg font-semibold text-gray-900">Organizations</h2>
                <div className="mt-4 space-y-3">
                  {profile.memberships.map(membership => (
                    <div
                      key={membership.org_id}
                      className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3"
                    >
                      <div>
                        <p className="font-medium text-gray-900">{membership.org_name}</p>
                        <p className="text-xs text-gray-500">
                          Joined {new Date(membership.joined_at).toLocaleDateString()}
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
              <div className="rounded-xl border border-gray-200 bg-white p-6">
                <h2 className="text-lg font-semibold text-gray-900">Contribution Stats</h2>
                <div className="mt-4 grid grid-cols-3 gap-4">
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      {profile.chain_stats.total_approved_memories}
                    </p>
                    <p className="text-xs text-gray-500">Approved Memories</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      {profile.chain_stats.total_serves}
                    </p>
                    <p className="text-xs text-gray-500">Total Serves</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      Epoch {profile.chain_stats.first_seen_epoch}
                    </p>
                    <p className="text-xs text-gray-500">First Seen</p>
                  </div>
                </div>
                {profile.chain_stats.reputation_tier && (
                  <div className="mt-4">
                    <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700">
                      Reputation: {profile.chain_stats.reputation_tier}
                    </span>
                  </div>
                )}
              </div>
            )}

            {profile.moderator_stats && (
              <div className="rounded-xl border border-gray-200 bg-white p-6">
                <h2 className="text-lg font-semibold text-gray-900">Moderator Activity</h2>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      {profile.moderator_stats.total_approvals}
                    </p>
                    <p className="text-xs text-gray-500">Total Approvals</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      {profile.moderator_stats.total_upheld_reports}
                    </p>
                    <p className="text-xs text-gray-500">Upheld Reports</p>
                  </div>
                </div>
              </div>
            )}

            {profile.leader_stats && (
              <div className="rounded-xl border border-gray-200 bg-white p-6">
                <h2 className="text-lg font-semibold text-gray-900">Leader Activity</h2>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      {profile.leader_stats.total_chain_commits}
                    </p>
                    <p className="text-xs text-gray-500">Chain Commits</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-gray-900">
                      {profile.leader_stats.total_epoch_rotations}
                    </p>
                    <p className="text-xs text-gray-500">Epoch Rotations</p>
                  </div>
                </div>
              </div>
            )}

            {!profile.chain_stats && !profile.moderator_stats && !profile.leader_stats && (
              <div className="rounded-xl border border-dashed border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
                No on-chain activity recorded.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
