'use client';

import { useState, useEffect } from 'react';
import { listJoinRequests, approveJoinRequest, denyJoinRequest, JoinRequest } from '@/lib/hub-client';

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

function truncatePubkey(pubkey: string): string {
  if (!pubkey) return 'N/A';
  if (pubkey.length <= 16) return pubkey;
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export default function JoinRequestsPage() {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending');
  const [processing, setProcessing] = useState<string | null>(null);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState('');
  const [approvalMode, setApprovalMode] = useState<Record<string, 'full' | 'trial'>>({});

  const orgId = typeof window !== 'undefined' ? (window as unknown as { __NEXT_PUBLIC_ORG_ID?: string }).__NEXT_PUBLIC_ORG_ID : '';

  useEffect(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    loadRequests();
  }, [orgId, statusFilter]);

  const loadRequests = async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const status = statusFilter === 'all' ? undefined : statusFilter;
      const resp = await listJoinRequests(orgId, status);
      setRequests(resp.requests || []);
    } catch (err) {
      console.error('Failed to load join requests:', err);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (requestId: string) => {
    if (!orgId) return;
    setProcessing(requestId);
    try {
      const mode = approvalMode[requestId] ?? 'full';
      await approveJoinRequest(orgId, requestId, mode === 'trial');
      setRequests(prev => prev.filter(r => r.request_id !== requestId));
      setApprovalMode(prev => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    } catch (err) {
      console.error('Failed to approve:', err);
      alert('Failed to approve request');
    } finally {
      setProcessing(null);
    }
  };

  const handleDeny = async (requestId: string) => {
    if (!orgId) return;
    setProcessing(requestId);
    try {
      await denyJoinRequest(orgId, requestId, denialReason || undefined);
      setRequests(prev => prev.filter(r => r.request_id !== requestId));
      setDenyingId(null);
      setDenialReason('');
    } catch (err) {
      console.error('Failed to deny:', err);
      alert('Failed to deny request');
    } finally {
      setProcessing(null);
    }
  };

  if (!orgId) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-4">Join Requests</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-800">
          No organization selected. Please select an organization first.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Join Requests</h1>
        <div className="flex gap-2">
          {(['pending', 'approved', 'denied', 'all'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-md text-sm ${
                statusFilter === status
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No {statusFilter !== 'all' ? statusFilter : ''} join requests.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <div key={request.request_id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-sm text-gray-900">{truncatePubkey(request.requester_pubkey)}</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Requested {formatRelativeTime(request.requested_at)}
                  </p>
                  {request.status === 'denied' && request.denial_reason && (
                    <p className="text-sm text-red-600 mt-1">
                      Denial reason: {request.denial_reason}
                    </p>
                  )}
                  {request.status === 'denied' && request.cooldown_until && (
                    <p className="text-sm text-gray-500 mt-1">
                      Cooldown until: {new Date(request.cooldown_until).toLocaleString()}
                    </p>
                  )}
                </div>
                {request.status === 'pending' && (
                  <div className="flex gap-2">
                    {denyingId === request.request_id ? (
                      <div className="flex flex-col gap-2">
                        <input
                          type="text"
                          value={denialReason}
                          onChange={(e) => setDenialReason(e.target.value)}
                          placeholder="Reason (optional)"
                          className="px-3 py-1 border border-gray-300 rounded text-sm"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleDeny(request.request_id)}
                            disabled={processing === request.request_id}
                            className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50"
                          >
                            Confirm Deny
                          </button>
                          <button
                            onClick={() => { setDenyingId(null); setDenialReason(''); }}
                            className="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <select
                          value={approvalMode[request.request_id] ?? 'full'}
                          onChange={(e) => setApprovalMode(prev => ({
                            ...prev,
                            [request.request_id]: e.target.value as 'full' | 'trial',
                          }))}
                          disabled={processing === request.request_id}
                          className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded border border-gray-300"
                        >
                          <option value="full">Full Member</option>
                          <option value="trial">Trial Member</option>
                        </select>
                        <button
                          onClick={() => handleApprove(request.request_id)}
                          disabled={processing === request.request_id}
                          className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50"
                        >
                          {processing === request.request_id ? 'Processing...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => setDenyingId(request.request_id)}
                          className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700"
                        >
                          Deny
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
