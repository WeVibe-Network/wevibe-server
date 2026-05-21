'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getOrg, submitJoinRequest, OrgSummary } from '@/lib/hub-client';

interface EnrichedOrgSummary extends OrgSummary {
  member_count?: number;
  last_activity_at?: string | null;
  leader_last_chain_commit_at?: string | null;
}

interface PageProps {
  params: { orgId: string };
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 30) return `${diffDays} days ago`;
  return formatDate(dateStr);
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
        <Link href="/discover" className="text-blue-600 hover:underline mb-4 inline-block">← Back to Discover</Link>
        <div className="text-center py-12 text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="p-6">
        <Link href="/discover" className="text-blue-600 hover:underline mb-4 inline-block">← Back to Discover</Link>
        <div className="text-center py-12 text-gray-500">Organization not found</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <Link href="/discover" className="text-blue-600 hover:underline mb-4 inline-block">← Back to Discover</Link>

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">{org.org_name}</h1>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Organization ID</h3>
            <p className="text-gray-900 font-mono text-sm">{org.org_id}</p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Leader</h3>
            <p className="text-gray-900 font-mono text-sm">{truncatePubkey(org.leader_pubkey)}</p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Current Epoch</h3>
            <p className="text-gray-900">{org.current_epoch}</p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Status</h3>
            <p className="text-gray-900 capitalize">{org.status}</p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Member Count</h3>
            <p className="text-gray-900">{org.member_count != null ? String(org.member_count) : 'N/A'}</p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Last Activity</h3>
            <p className="text-gray-900">{org.last_activity_at ? formatRelativeTime(org.last_activity_at) : 'N/A'}</p>
          </div>

          {org.leader_last_chain_commit_at ? (
            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-1">Leader Last Active</h3>
              <p className="text-gray-900">{formatRelativeTime(org.leader_last_chain_commit_at)}</p>
            </div>
          ) : null}

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-1">Created</h3>
            <p className="text-gray-900">{formatDate(org.created_at)}</p>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200">
          {joinStatus === 'success' ? (
            <div className="px-6 py-3 bg-green-100 text-green-800 rounded-lg">
              Join request submitted! Check notifications for updates.
            </div>
          ) : (
            <div>
              <button
                onClick={handleJoin}
                disabled={joining}
                className="px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {joining ? 'Submitting...' : 'Request to Join'}
              </button>
              {joinStatus === 'error' && (
                <p className="mt-2 text-sm text-red-600">{joinError}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}