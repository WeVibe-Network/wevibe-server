'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { discoverOrgs, DiscoverOrg } from '@/lib/hub-client';
import { getIdentity } from '@/lib/wevibe-auth';
import ClientTime from '@/components/ui/client-time';

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
  const [myPubkey, setMyPubkey] = useState<string | null>(null);
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
    getIdentity()
      .then(id => {
        setMyPubkey(id?.pubkeyHex ?? null);
      })
      .catch(() => {
        // Ignore identity load failures; owned highlighting is optional.
      });
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
        <h1 className="text-2xl font-semibold text-wv-text mb-4">Discover Organizations</h1>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search organizations..."
            className="flex-1 px-4 py-2 rounded-[11px] border border-wv-line-2 bg-wv-panel-2 text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-wv-grad-btn text-white rounded-md hover:opacity-95"
          >
            Search
          </button>
        </form>
        <p className="mt-2 text-sm text-wv-dim font-mono">{total} organizations found</p>
      </div>

      {loading && orgs.length === 0 ? (
        <div className="text-center py-12 text-wv-dim">Loading...</div>
      ) : orgs.length === 0 ? (
        <div className="text-center py-12 text-wv-dim">
          No organizations found. Try a different search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {orgs.map((org) => {
              const owned = myPubkey != null && org.leader_pubkey === myPubkey;

              return (
                <Link
                  key={org.org_id}
                  href={`/discover/${org.org_id}`}
                  className={`block p-4 bg-wv-panel border rounded-lg hover:border-[rgba(124,92,255,0.4)] hover:shadow-wv-md transition ${owned ? 'border-wv-violet shadow-wv-md' : 'border-wv-line shadow-wv-sm'}`}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-lg font-medium text-wv-text">{org.org_name}</h3>
                    {owned && (
                      <span className="inline-flex items-center rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.14)] px-2 py-0.5 text-xs font-medium text-wv-violet">
                        Your org
                      </span>
                    )}
                  </div>
                  <div className="space-y-1 text-sm text-wv-dim font-mono">
                    <p>Domain: {org.domain}</p>
                    <p>Leader: {truncatePubkey(org.leader_pubkey)}</p>
                    <p>Members: {org.member_count}</p>
                    <p>Epoch: {org.current_epoch}</p>
                    <p>Last active: <ClientTime value={org.last_activity_at} mode="relative" fallback="Never" /></p>
                  </div>
                  <div className="mt-3">
                    <span className="text-wv-violet text-sm font-medium">View details →</span>
                  </div>
                </Link>
              );
            })}
          </div>

          {hasMore && (
            <div className="mt-6 text-center">
              <button
                onClick={loadMore}
                disabled={loading}
                className="px-6 py-2 bg-wv-panel text-wv-text rounded-md border border-wv-line hover:bg-wv-panel-2 disabled:opacity-50 font-mono"
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
