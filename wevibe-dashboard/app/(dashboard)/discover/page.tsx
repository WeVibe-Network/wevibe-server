'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { discoverOrgs, DiscoverOrg } from '@/lib/hub-client';

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}`;
}

export default function DiscoverPage() {
  const [orgs, setOrgs] = useState<DiscoverOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const loadOrgs = useCallback(async (searchTerm: string, offsetVal: number) => {
    setLoading(true);
    try {
      const resp = await discoverOrgs({ limit, offset: offsetVal, search: searchTerm || undefined });
      if (offsetVal === 0) {
        setOrgs(resp.orgs);
      } else {
        setOrgs(prev => [...prev, ...resp.orgs]);
      }
      setTotal(resp.total);
      setHasMore(resp.has_more);
      setOffset(offsetVal);
    } catch (err) {
      console.error('Failed to load orgs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrgs(search, 0);
  }, [search, loadOrgs]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
  };

  const loadMore = () => {
    loadOrgs(search, offset + limit);
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-4">Discover Organizations</h1>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search organizations..."
            className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Search
          </button>
        </form>
        <p className="mt-2 text-sm text-gray-600">{total} organizations found</p>
      </div>

      {loading && orgs.length === 0 ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : orgs.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No organizations found. Try a different search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {orgs.map((org) => (
              <Link
                key={org.org_id}
                href={`/discover/${org.org_id}`}
                className="block p-4 bg-white border border-gray-200 rounded-lg hover:border-blue-500 hover:shadow-md transition"
              >
                <h3 className="text-lg font-medium text-gray-900 mb-2">{org.org_name}</h3>
                <div className="space-y-1 text-sm text-gray-600">
                  <p>Leader: {truncatePubkey(org.leader_pubkey)}</p>
                  <p>Members: {org.member_count}</p>
                  <p>Epoch: {org.current_epoch}</p>
                  <p>Last active: {formatRelativeTime(org.last_activity_at)}</p>
                </div>
                <div className="mt-3">
                  <span className="text-blue-600 text-sm font-medium">View details →</span>
                </div>
              </Link>
            ))}
          </div>

          {hasMore && (
            <div className="mt-6 text-center">
              <button
                onClick={loadMore}
                disabled={loading}
                className="px-6 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}