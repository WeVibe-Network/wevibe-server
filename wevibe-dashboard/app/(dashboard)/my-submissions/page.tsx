'use client';

import { useState, useEffect } from 'react';
import { getMySubmissions, type MySubmission } from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';
import Badge from '@/components/ui/badge';
import ClientTime from '@/components/ui/client-time';

function truncateHash(hash: string): string {
  if (!hash) return 'N/A';
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function statusVariant(status: string): 'default' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'pending_keyword':
      return 'warning';
    case 'pending_chain':
      return 'warning';
    case 'committed':
      return 'success';
    case 'denied':
      return 'error';
    default:
      return 'default';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending_keyword':
      return 'Keywords Pending';
    case 'pending_chain':
      return 'Chain Submission Pending';
    case 'committed':
      return 'On Chain';
    case 'denied':
      return 'Denied';
    default:
      return status;
  }
}

export default function MySubmissionsPage() {
  const [submissions, setSubmissions] = useState<MySubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { activeOrg } = useOrgContext();

  useEffect(() => {
    if (!activeOrg?.org_id) {
      setLoading(false);
      return;
    }
    loadSubmissions();
  }, [activeOrg?.org_id]);

  const loadSubmissions = async () => {
    if (!activeOrg?.org_id) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await getMySubmissions(activeOrg.org_id);
      setSubmissions(resp.submissions || []);
    } catch (err) {
      console.error('Failed to load submissions:', err);
      setError('Failed to load submissions');
      setSubmissions([]);
    } finally {
      setLoading(false);
    }
  };

  if (!activeOrg?.org_id) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-semibold text-wv-text">My Submissions</h1>
        <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-4 text-wv-amber">
          No organization selected. Please select an organization first.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-wv-text">My Submissions</h1>
        <button
          onClick={loadSubmissions}
          className="rounded-md border border-wv-line-2 bg-wv-panel px-4 py-2 text-sm font-medium text-wv-text hover:bg-wv-line"
        >
          Refresh
        </button>
      </div>

      {loading && submissions.length === 0 ? (
        <div className="py-12 text-center text-wv-dim">Loading submissions...</div>
      ) : error ? (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] p-4 text-wv-red">{error}</div>
      ) : submissions.length === 0 ? (
        <div className="rounded-lg border border-wv-line bg-wv-panel p-8 text-center text-wv-dim">
          No submissions yet. Submit memories from the Sessions page.
        </div>
      ) : (
        <div className="space-y-4">
          {submissions.map((sub) => (
            <div
              key={sub.submission_hash}
              className="rounded-lg border border-wv-line bg-wv-panel p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={statusVariant(sub.status)}>{statusLabel(sub.status)}</Badge>
                    <span className="text-xs font-mono text-wv-dim">{sub.memory_type}</span>
                  </div>
                  <div className="mb-1 text-sm text-wv-dim">
                    Hash: <span className="font-mono">{truncateHash(sub.submission_hash)}</span>
                  </div>
                  <div className="mb-1 text-sm text-wv-dim">
                    Epoch: <span className="font-mono">{sub.epoch_id}</span>
                  </div>
                  <div className="text-xs font-mono text-wv-faint">
                    Submitted <ClientTime value={sub.created_at} mode="relative" />
                  </div>
                  {sub.status === 'denied' && sub.denial_reason && (
                    <div className="mt-3 rounded-md border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] p-3">
                      <div className="mb-1 text-xs font-medium text-wv-red">Denial Reason:</div>
                      <div className="text-sm text-wv-red">{sub.denial_reason}</div>
                    </div>
                  )}
                  {sub.status === 'pending_keyword' && sub.extraction_feedback && (
                    <div className="mt-3 rounded-md border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-3">
                      <div className="mb-1 text-xs font-medium text-wv-amber">Feedback:</div>
                      <div className="text-sm text-wv-amber">{sub.extraction_feedback}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
