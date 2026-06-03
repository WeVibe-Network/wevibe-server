'use client';

import { useState, useEffect } from 'react';
import { listJoinRequests, approveJoinRequest, denyJoinRequest, JoinRequest } from '@/lib/hub-client';
import { relayBroadcast } from '@/lib/relay-client';
import { connectWallet } from '@/lib/wallet-connect';
import type { EncodeObject } from '@/lib/chain-client';
import ClientTime from '@/components/ui/client-time';

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
    let hubApproved = false;
    try {
      const request = requests.find(r => r.request_id === requestId);
      if (!request) {
        throw new Error('Join request not found in current list');
      }

      const walletConn = await connectWallet();
      const mode = approvalMode[requestId] ?? 'full';
      await approveJoinRequest(orgId, requestId, mode === 'trial');
      hubApproved = true;

      const msgAddMember = {
        typeUrl: '/wevibe.org.v1.MsgAddMember',
        value: Buffer.from(JSON.stringify({
          signer: walletConn.address,
          org_id: orgId,
          pubkey: request.requester_pubkey,
          role: 'member',
        })),
      } as unknown as EncodeObject;
      await relayBroadcast(orgId, walletConn.address, [msgAddMember]);

      setRequests(prev => prev.filter(r => r.request_id !== requestId));
      setApprovalMode(prev => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    } catch (err) {
      console.error('Failed to approve:', err);
      if (hubApproved) {
        alert('Request was approved, but on-chain membership sync failed. Please retry the on-chain add member step.');
      } else {
        alert('Failed to approve request');
      }
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
        <h1 className="text-2xl font-semibold text-wv-text mb-4">Join Requests</h1>
        <div className="bg-[rgba(255,178,85,0.12)] border border-[rgba(255,178,85,0.4)] rounded-lg p-4 text-wv-amber">
          No organization selected. Please select an organization first.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-wv-text">Join Requests</h1>
        <div className="flex gap-2">
          {(['pending', 'approved', 'denied', 'all'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-md text-sm ${
                statusFilter === status
                  ? 'bg-wv-grad-btn text-white'
                  : 'bg-wv-panel text-wv-text hover:bg-wv-panel-2'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-wv-dim">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-12 text-wv-dim">
          No {statusFilter !== 'all' ? statusFilter : ''} join requests.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <div key={request.request_id} className="bg-wv-panel border border-wv-line rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-sm text-wv-text">{truncatePubkey(request.requester_pubkey)}</p>
                  <p className="text-sm text-wv-dim mt-1">
                    Requested <ClientTime value={request.requested_at} mode="relative" />
                  </p>
                  {request.status === 'denied' && request.denial_reason && (
                    <p className="text-sm text-wv-red mt-1">
                      Denial reason: {request.denial_reason}
                    </p>
                  )}
                  {request.status === 'denied' && request.cooldown_until && (
                    <p className="text-sm text-wv-dim mt-1">
                      Cooldown until: <ClientTime value={request.cooldown_until} mode="datetime" />
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
                          className="px-3 py-1 bg-wv-panel-2 border border-wv-line-2 text-wv-text rounded text-sm placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleDeny(request.request_id)}
                            disabled={processing === request.request_id}
                            className="px-3 py-1 bg-wv-red text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
                          >
                            Confirm Deny
                          </button>
                          <button
                            onClick={() => { setDenyingId(null); setDenialReason(''); }}
                            className="px-3 py-1 bg-wv-panel-2 text-wv-text text-sm rounded hover:bg-wv-panel-3"
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
                          className="px-3 py-2 bg-wv-panel-2 text-wv-text text-sm rounded border border-wv-line-2 focus:outline-none focus:border-wv-violet"
                        >
                          <option value="full">Full Member</option>
                          <option value="trial">Trial Member</option>
                        </select>
                        <button
                          onClick={() => handleApprove(request.request_id)}
                          disabled={processing === request.request_id}
                          className="px-4 py-2 bg-wv-green text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
                        >
                          {processing === request.request_id ? 'Processing...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => setDenyingId(request.request_id)}
                          className="px-4 py-2 bg-wv-red text-white text-sm rounded hover:opacity-90"
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
