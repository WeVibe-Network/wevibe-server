'use client';

import { useState, useEffect } from 'react';
import { getMySubmissions, type MySubmission } from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';
import Badge from '@/components/ui/badge';

function formatRelativeTime(dateStr: string): string {
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

function truncateHash(hash: string): string {
  if (!hash) return 'N/A';
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function statusVariant(status: string): 'default' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'pending':
      return 'warning';
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
    case 'pending':
      return 'Pending Moderation';
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
        <h1 className="text-2xl font-semibold text-gray-900 mb-4">My Submissions</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          No organization selected. Please select an organization first.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">My Submissions</h1>
        <button
          onClick={loadSubmissions}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {loading && submissions.length === 0 ? (
        <div className="text-center py-12 text-gray-500">Loading submissions...</div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">{error}</div>
      ) : submissions.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500">
          No submissions yet. Submit memories from the Sessions page.
        </div>
      ) : (
        <div className="space-y-4">
          {submissions.map((sub) => (
            <div
              key={sub.submission_hash}
              className="bg-white border border-gray-200 rounded-lg p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={statusVariant(sub.status)}>{statusLabel(sub.status)}</Badge>
                    <span className="text-xs text-gray-500">{sub.memory_type}</span>
                  </div>
                  <div className="text-sm text-gray-500 mb-1">
                    Hash: <span className="font-mono">{truncateHash(sub.submission_hash)}</span>
                  </div>
                  <div className="text-sm text-gray-500 mb-1">
                    Epoch: {sub.epoch_id}
                  </div>
                  <div className="text-xs text-gray-400">
                    Submitted {formatRelativeTime(sub.created_at)}
                  </div>
                  {sub.status === 'denied' && sub.denial_reason && (
                    <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-md">
                      <div className="text-xs font-medium text-red-800 mb-1">Denial Reason:</div>
                      <div className="text-sm text-red-700">{sub.denial_reason}</div>
                    </div>
                  )}
                  {sub.status === 'pending_keyword' && sub.extraction_feedback && (
                    <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                      <div className="text-xs font-medium text-yellow-800 mb-1">Feedback:</div>
                      <div className="text-sm text-yellow-700">{sub.extraction_feedback}</div>
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