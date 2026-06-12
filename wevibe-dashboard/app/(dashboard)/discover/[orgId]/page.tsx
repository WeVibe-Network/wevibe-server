'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getOrg, submitJoinRequest, OrgSummary } from '@/lib/hub-client';
import ClientTime from '@/components/ui/client-time';

interface EnrichedOrgSummary extends OrgSummary {
  member_count?: number;
  last_activity_at?: string | null;
}

interface PageProps {
  params: { orgId: string };
}

function truncatePubkey(pubkey: string): string {
  if (!pubkey) return 'N/A';
  if (pubkey.length <= 16) return pubkey;
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export default function OrgDetailPage({ params }: PageProps) {
  const [org, setOrg] = useState<EnrichedOrgSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [joinStatus, setJoinStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    getOrg(params.orgId)
      .then(setOrg)
      .catch(() => setOrg(null))
      .finally(() => setLoading(false));
  }, [params.orgId]);

  const handleJoin = async () => {
    setJoining(true);
    setJoinError('');
    try {
      await submitJoinRequest(params.orgId);
      setJoinStatus('success');
    } catch (err: unknown) {
      setJoinStatus('error');
      const errorMessage = err instanceof Error ? err.message : 'Failed to submit join request.';
      if (errorMessage.includes('409')) {
        setJoinError('You are already a member or have a pending request.');
      } else if (errorMessage.includes('429')) {
        setJoinError('You are in a cooldown period. Please try again later.');
      } else {
        setJoinError(errorMessage);
      }
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <Link href="/discover" className="text-wv-violet hover:underline mb-4 inline-block">← Back to Discover</Link>
        <div className="text-center py-12 text-wv-dim">Loading...</div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="p-6">
        <Link href="/discover" className="text-wv-violet hover:underline mb-4 inline-block">← Back to Discover</Link>
        <div className="text-center py-12 text-wv-dim">Organization not found</div>
      </div>
    );
  }

  const orgDescription = org.description?.trim() ?? '';
  const orgTechStack = org.tech_stack?.trim() ?? '';
  const orgFocusAreas = org.focus_areas?.trim() ?? '';

  return (
    <div className="p-6">
      <Link href="/discover" className="text-wv-violet hover:underline mb-4 inline-block">← Back to Discover</Link>

      <div className="bg-wv-panel border border-wv-line rounded-lg p-6 shadow-wv-sm">
        <h1 className="text-3xl font-bold text-wv-text mb-6">{org.org_name}</h1>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Organization ID</h3>
            <p className="text-wv-text font-mono text-sm">{org.org_id}</p>
          </div>

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Domain of Expertise</h3>
            <p className="text-wv-text text-sm">{org.domain}</p>
          </div>

          {orgDescription && (
            <div className="col-span-2">
              <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Description</h3>
              <p className="text-wv-text text-sm">{orgDescription}</p>
            </div>
          )}

          {orgTechStack && (
            <div className="col-span-2">
              <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Tech Stack</h3>
              <p className="text-wv-text text-sm">{orgTechStack}</p>
            </div>
          )}

          {orgFocusAreas && (
            <div className="col-span-2">
              <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Focus Areas</h3>
              <p className="text-wv-text text-sm">{orgFocusAreas}</p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Leader</h3>
            <p className="text-wv-text font-mono text-sm">{truncatePubkey(org.leader_pubkey)}</p>
          </div>

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Current Epoch</h3>
            <p className="text-wv-text font-mono">{org.current_epoch}</p>
          </div>

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Status</h3>
            <p className="text-wv-text capitalize font-mono">{org.status}</p>
          </div>

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Member Count</h3>
            <p className="text-wv-text font-mono">{org.member_count != null ? String(org.member_count) : 'N/A'}</p>
          </div>

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Last Activity</h3>
            <p className="text-wv-text font-mono"><ClientTime value={org.last_activity_at} mode="relative" fallback="N/A" /></p>
          </div>

          <div>
            <h3 className="text-sm font-mono font-medium uppercase tracking-[0.08em] text-wv-dim mb-1">Created</h3>
            <p className="text-wv-text font-mono"><ClientTime value={org.created_at} mode="date" /></p>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-wv-line">
          {joinStatus === 'success' ? (
            <div className="px-6 py-3 bg-[rgba(54,211,153,0.12)] border border-[rgba(54,211,153,0.4)] text-wv-green rounded-lg">
              Join request submitted! Check notifications for updates.
            </div>
          ) : (
            <div>
              <button
                onClick={handleJoin}
                disabled={joining}
                className="px-6 py-3 bg-wv-grad-btn text-white font-medium rounded-lg hover:opacity-95 disabled:opacity-50"
              >
                {joining ? 'Submitting...' : 'Request to Join'}
              </button>
              {joinStatus === 'error' && (
                <p className="mt-2 text-sm text-wv-red">{joinError}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
