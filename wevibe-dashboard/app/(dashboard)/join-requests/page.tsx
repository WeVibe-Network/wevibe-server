'use client';

import { useState, useEffect } from 'react';
import { listJoinRequests, approveJoinRequest, cancelJoinApproval, denyJoinRequest, JoinRequest } from '@/lib/hub-client';
import { connectWallet } from '@/lib/wallet-connect';
import { buildAddMemberMsg, directBroadcast, getOrgAccountAddress } from '@/lib/chain-client';
import { useOrgContext } from '@/lib/org-context';
import ClientTime from '@/components/ui/client-time';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';

function truncatePubkey(pubkey: string): string {
  if (!pubkey) return 'N/A';
  if (pubkey.length <= 16) return pubkey;
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export default function JoinRequestsPage() {
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id ?? '';
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending');
  const [processing, setProcessing] = useState<string | null>(null);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState('');
  const [approvalMode, setApprovalMode] = useState<Record<string, 'full' | 'trial'>>({});

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

  const handleApprove = async (requestId: string, wantContributor: boolean) => {
    if (!orgId) return;
    setProcessing(requestId);
    const id = txToast('Approve');
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
      txConfirming(id, 'Approve');

      const msgAddMember = buildAddMemberMsg(
        walletConn.address,
        orgId,
        request.requester_pubkey,
        'member',
        request.x25519_pubkey,
        wantContributor,
        false,
      );
      const orgAccount = await getOrgAccountAddress(orgId);
      const result = await directBroadcast(walletConn.address, [msgAddMember], orgAccount);

      setRequests(prev => prev.filter(r => r.request_id !== requestId));
      setApprovalMode(prev => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      txSuccess(id, 'Approved — confirming on-chain; the member appears once the tx is confirmed.', result.txHash);
    } catch (err) {
      console.error('Failed to approve:', err);
      if (hubApproved) {
        try {
          await cancelJoinApproval(orgId, requestId);
          txError(id, 'On-chain approval was cancelled/failed — request returned to pending.');
        } catch (cancelErr) {
          console.error('Failed to cancel join approval:', cancelErr);
          txError(id, 'On-chain approval failed and restoring pending status failed. Refresh and retry.');
        }
      } else {
        txError(id, 'Failed to approve request');
      }
    } finally {
      setProcessing(null);
    }
  };

  const handleDeny = async (requestId: string) => {
    if (!orgId) return;
    setProcessing(requestId);
    const id = txToast('Deny');
    try {
      await denyJoinRequest(orgId, requestId, denialReason || undefined);
      setRequests(prev => prev.filter(r => r.request_id !== requestId));
      setDenyingId(null);
      setDenialReason('');
      txSuccess(id, 'Request denied');
    } catch (err) {
      console.error('Failed to deny:', err);
      txError(id, 'Failed to deny request');
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
                          onClick={() => handleApprove(request.request_id, false)}
                          disabled={processing === request.request_id}
                          className="px-4 py-2 bg-wv-panel-2 text-wv-text text-sm rounded hover:bg-wv-panel-3 disabled:opacity-50"
                        >
                          {processing === request.request_id ? 'Processing...' : 'Approve as member'}
                        </button>
                        <button
                          onClick={() => handleApprove(request.request_id, true)}
                          disabled={processing === request.request_id}
                          className="px-4 py-2 bg-wv-green text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
                        >
                          {processing === request.request_id ? 'Processing...' : 'Approve as contributor'}
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
