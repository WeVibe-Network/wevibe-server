'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { listMembers, enableMemberRecall, type MemberRecord } from '@/lib/hub-client'
import { getIdentity } from '@/lib/wevibe-auth'
import { connectWallet } from '@/lib/wallet-connect'
import {
  buildAddMemberMsg,
  buildCloseOrgMsg,
  buildRemoveMemberMsg,
  buildTransferLeadershipMsg,
  buildUpdateMemberRoleMsg,
  directBroadcast,
  getOrgAccountAddress,
} from '@/lib/chain-client'
import type { OrgRole } from '@/lib/org-role'
import { useOrgContext } from '@/lib/org-context'
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast'
import Button from '@/components/ui/button'
import Card from '@/components/ui/card'
import ClientTime from '@/components/ui/client-time'

const ROLE_COLORS: Record<string, string> = {
  leader:    'bg-[rgba(124,92,255,0.14)] text-wv-violet',
  moderator: 'bg-[rgba(52,220,240,0.12)] text-wv-cyan',
  contributor: 'bg-[rgba(255,178,85,0.14)] text-wv-amber',
  member:    'bg-wv-panel-2 text-wv-dim',
}

type ViewerRole = OrgRole

export default function MembersPage() {
  const router = useRouter()
  const { activeOrg } = useOrgContext()
  const orgId = activeOrg?.org_id ?? ''
  const [members, setMembers] = useState<MemberRecord[]>([])
  const [viewerPubkey, setViewerPubkey] = useState<string>('')
  const [viewerRole, setViewerRole] = useState<ViewerRole>('member')
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  const [invitePubkey, setInvitePubkey] = useState('')
  const [inviteX25519Pubkey, setInviteX25519Pubkey] = useState('')
  const [inviteRole, setInviteRole] = useState<'moderator' | 'member' | 'contributor'>('member')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState('')

  const [roleChangeTarget, setRoleChangeTarget] = useState<string | null>(null)
  const [roleChangeLoading, setRoleChangeLoading] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)

  const [enableRecallTarget, setEnableRecallTarget] = useState<string | null>(null)

  const [transferTarget, setTransferTarget] = useState<string | null>(null)
  const [transferLoading, setTransferLoading] = useState(false)

  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeLoading, setCloseLoading] = useState(false)

  async function resolveOrgAccountForGas() {
    try {
      const orgAccount = (await getOrgAccountAddress(orgId)).trim()
      if (!orgAccount) {
        throw new Error('missing org account')
      }
      return orgAccount
    } catch {
      throw new Error('could not resolve org account for gas')
    }
  }

  async function refreshMembers() {
    setLoading(true)
    setError('')
    try {
      const data = await listMembers(orgId)
      setMembers(data ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!orgId) { setLoading(false); return }
    ;(async () => {
      const id = await getIdentity()
      if (!id) {
        setLoading(false)
        router.push('/login')
        return
      }
      setViewerPubkey(id.pubkeyHex)
      await refreshMembers()
    })().catch((err) => {
      setError((err as Error).message)
      setLoading(false)
    })
  }, [orgId, router])

  useEffect(() => {
    if (members.length > 0 && viewerPubkey) {
      const viewer = members.find(m => m.pubkey === viewerPubkey)
      if (viewer) {
        setViewerRole(viewer.role)
      }
    }
  }, [members, viewerPubkey])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviteLoading(true)
    setInviteError('')
    setInviteSuccess('')
    const id = txToast('Invite')
    try {
      const walletConn = await connectWallet()
      txConfirming(id, 'Invite')
      const msgAddMember = buildAddMemberMsg(walletConn.address, orgId, invitePubkey, inviteRole, inviteX25519Pubkey)
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msgAddMember], orgAccount)
      const successMessage = `Invited ${invitePubkey.slice(0, 12)}… as ${inviteRole}`
      txSuccess(id, successMessage, result.txHash)
      setInviteSuccess(successMessage)
      setInvitePubkey('')
      setInviteX25519Pubkey('')
      setInviteRole('member')
      await refreshMembers()
    } catch (err) {
      const message = (err as Error).message
      setInviteError(message)
      txError(id, message)
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleRoleChange(pubkey: string, newRole: string) {
    setRoleChangeLoading(true)
    const id = txToast('Role change')
    try {
      const walletConn = await connectWallet()
      txConfirming(id, 'Role change')
      const msgUpdateMemberRole = buildUpdateMemberRoleMsg(walletConn.address, orgId, pubkey, newRole)
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msgUpdateMemberRole], orgAccount)
      setRoleChangeTarget(null)
      await refreshMembers()
      txSuccess(id, `Role updated to ${newRole}`, result.txHash)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      txError(id, message)
    } finally {
      setRoleChangeLoading(false)
    }
  }

  async function handleRemove(pubkey: string) {
    setRemoveLoading(true)
    const id = txToast('Remove member')
    try {
      const walletConn = await connectWallet()
      txConfirming(id, 'Remove member')
      const msgRemoveMember = buildRemoveMemberMsg(walletConn.address, orgId, pubkey)
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msgRemoveMember], orgAccount)
      setRemoveTarget(null)
      await refreshMembers()
      txSuccess(id, 'Member removed', result.txHash)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      txError(id, message)
    } finally {
      setRemoveLoading(false)
    }
  }

  async function handleEnableRecall(pubkey: string) {
    setEnableRecallTarget(pubkey)
    setError('')
    const id = toast.loading('Enabling recall…')
    try {
      await enableMemberRecall(orgId, pubkey)
      await refreshMembers()
      toast.success('Recall enabled for this member', { id })
    } catch (err) {
      const status = typeof err === 'object' && err !== null
        ? (err as { status?: number }).status
        : undefined
      if (status === 402) {
        setError('Org has insufficient credits to enable recall')
        toast.error('Org has insufficient recall credits — top up to enable recall.', { id })
      } else {
        const message = (err as Error).message
        setError(message)
        toast.error(message, { id })
      }
    } finally {
      setEnableRecallTarget(null)
    }
  }

  async function handleTransfer(pubkey: string) {
    setTransferLoading(true)
    const id = txToast('Transfer leadership')
    try {
      const targetMember = members.find(member => member.pubkey === pubkey)
      if (!targetMember) {
        throw new Error('Selected member not found')
      }

      const targetWalletAddress = targetMember.wallet_address?.trim()
      if (!targetWalletAddress) {
        const message = 'The new leader must link a wallet address before leadership can be transferred.'
        setError(message)
        txError(id, message)
        return
      }

      const walletConn = await connectWallet()
      txConfirming(id, 'Transfer leadership')
      const msgTransferLeadership = buildTransferLeadershipMsg(
        walletConn.address,
        orgId,
        pubkey,
        targetWalletAddress,
      )
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msgTransferLeadership], orgAccount)
      setTransferTarget(null)
      await refreshMembers()
      txSuccess(id, 'Leadership transferred', result.txHash)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      txError(id, message)
    } finally {
      setTransferLoading(false)
    }
  }

  async function handleCloseOrg() {
    setCloseLoading(true)
    const id = txToast('Close org')
    try {
      const walletConn = await connectWallet()
      txConfirming(id, 'Close org')
      const msgCloseOrg = buildCloseOrgMsg(walletConn.address, orgId)
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msgCloseOrg], orgAccount)
      setCloseDialogOpen(false)
      await refreshMembers()
      txSuccess(id, 'Org closed', result.txHash)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      txError(id, message)
    } finally {
      setCloseLoading(false)
    }
  }

  if (!orgId) return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Members</h1>
      <p className="text-sm text-wv-amber bg-[rgba(255,178,85,0.12)] border border-[rgba(255,178,85,0.4)] rounded-lg p-4">
        No organization selected. Please select an organization first.
      </p>
    </div>
  )

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Members</h1>
      {error && <p className="text-wv-red text-sm mb-4">{error}</p>}

      {viewerRole === 'leader' && (
        <Card className="p-6">
          <h2 className="text-lg font-medium mb-4">Invite Member</h2>
          <form onSubmit={handleInvite} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-wv-text mb-1">Public Key</label>
                <input
                  type="text"
                  data-testid="invite-pubkey-input"
                  value={invitePubkey}
                  onChange={e => setInvitePubkey(e.target.value)}
                  placeholder="0000..."
                  required
                  className="w-full bg-wv-panel-2 border border-wv-line-2 text-wv-text rounded-[11px] px-3 py-2 text-sm font-mono placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-wv-text mb-1">X25519 Public Key</label>
                <input
                  type="text"
                  data-testid="invite-x25519-input"
                  value={inviteX25519Pubkey}
                  onChange={e => setInviteX25519Pubkey(e.target.value)}
                  placeholder="0000..."
                  required
                  className="w-full bg-wv-panel-2 border border-wv-line-2 text-wv-text rounded-[11px] px-3 py-2 text-sm font-mono placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-wv-text mb-1">Role</label>
                <select
                  data-testid="invite-role-select"
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as 'moderator' | 'member' | 'contributor')}
                  className="w-full bg-wv-panel-2 border border-wv-line-2 text-wv-text rounded-[11px] px-3 py-2 text-sm focus:outline-none focus:border-wv-violet"
                >
                  <option value="member">Member</option>
                  <option value="moderator">Moderator</option>
                  <option value="contributor">Contributor</option>
                </select>
              </div>
            </div>
            {inviteError && <p className="text-wv-red text-sm">{inviteError}</p>}
            {inviteSuccess && <p className="text-wv-green text-sm">{inviteSuccess}</p>}
            <div>
              <Button type="submit" disabled={inviteLoading} data-testid="invite-submit-button">
                {inviteLoading ? 'Inviting...' : 'Invite Member'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? <p className="text-wv-faint text-sm">Loading...</p> : (
        <div className="bg-wv-panel border border-wv-line rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-wv-line bg-wv-panel-2">
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Member</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Role</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Epoch</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Status</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Dismissed</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Joined</th>
                {viewerRole === 'leader' && <th className="text-left px-4 py-3 font-medium text-wv-dim">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.pubkey} className="border-b border-wv-line last:border-0">
                  <td className="px-4 py-3 text-xs">
                    <p className="font-medium text-wv-text" title={m.wallet_address || m.pubkey}>{m.display_name || 'Unnamed'}</p>
                    <p className="font-mono text-wv-dim">{m.pubkey.slice(0, 20)}…</p>
                  </td>
                  <td className="px-4 py-3">
                    {roleChangeTarget === m.pubkey ? (
                      <select
                        data-testid="role-change-select"
                        defaultValue={m.role}
                        onChange={e => handleRoleChange(m.pubkey, e.target.value)}
                        onBlur={() => setRoleChangeTarget(null)}
                        autoFocus
                        className="rounded bg-wv-panel-2 border border-wv-line-2 text-wv-text px-2 py-1 text-xs focus:outline-none focus:border-wv-violet"
                      >
                        <option value="moderator">Moderator</option>
                        <option value="contributor">Contributor</option>
                        <option value="member">Member</option>
                      </select>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${ROLE_COLORS[m.role] ?? 'bg-wv-panel-2 text-wv-dim'}`}>
                        {m.role}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-wv-dim">{m.join_epoch}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${m.active ? 'bg-[rgba(54,211,153,0.12)] text-wv-green' : 'bg-wv-panel-2 text-wv-faint'}`}>
                        {m.active ? 'active' : 'inactive'}
                      </span>
                      <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${m.membership_active ? 'bg-[rgba(54,211,153,0.08)] text-wv-green' : 'bg-wv-panel-2 text-wv-faint'}`}>
                        {m.membership_active ? 'recall: on' : 'recall: off'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(m.dismissed_reports_count ?? 0) > 0 ? (
                      <span className="text-wv-amber font-medium">{m.dismissed_reports_count}</span>
                    ) : (
                      <span className="text-wv-faint">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-wv-faint text-xs">
                    <ClientTime value={m.joined_at} mode="date" />
                  </td>
                  {viewerRole === 'leader' && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {!m.membership_active && (
                          <button
                            data-testid="enable-recall-trigger"
                            onClick={() => handleEnableRecall(m.pubkey)}
                            disabled={enableRecallTarget === m.pubkey}
                            className="text-xs text-wv-green hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                          >
                            {enableRecallTarget === m.pubkey ? 'Enabling...' : 'Enable recall'}
                          </button>
                        )}
                        <button
                          data-testid="role-change-trigger"
                          onClick={() => setRoleChangeTarget(m.pubkey)}
                          disabled={roleChangeLoading || m.role === 'leader'}
                          className="text-xs text-wv-violet hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                        >
                          Change Role
                        </button>
                        <button
                          data-testid="remove-member-trigger"
                          onClick={() => setRemoveTarget(m.pubkey)}
                          disabled={removeLoading || m.role === 'leader'}
                          className="text-xs text-wv-red hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                        >
                          Remove
                        </button>
                        <button
                          data-testid="transfer-leadership-trigger"
                          onClick={() => setTransferTarget(m.pubkey)}
                          disabled={transferLoading || m.role === 'leader'}
                          className="text-xs text-wv-violet hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                        >
                          Transfer Leadership
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {members.length === 0 && (
            <p className="text-center py-8 text-wv-faint">No members found</p>
          )}
        </div>
      )}

      {removeTarget && (
        <div className="fixed inset-0 bg-wv-bg/70 flex items-center justify-center z-50">
          <Card className="p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-medium mb-2">Remove Member</h3>
            <p className="text-sm text-wv-dim mb-4">
              Are you sure you want to remove <span className="font-mono">{removeTarget.slice(0, 12)}…</span>?
            </p>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => handleRemove(removeTarget)}
                disabled={removeLoading}
              >
                {removeLoading ? 'Removing...' : 'Remove'}
              </Button>
              <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      )}

      {transferTarget && (
        <div className="fixed inset-0 bg-wv-bg/70 flex items-center justify-center z-50">
          <Card className="p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-medium mb-2">Transfer Leadership</h3>
            <p className="text-sm text-wv-dim mb-4">
              Transfer leadership to <span className="font-mono">{transferTarget.slice(0, 12)}…</span>?
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => handleTransfer(transferTarget)}
                disabled={transferLoading}
              >
                {transferLoading ? 'Transferring...' : 'Transfer'}
              </Button>
              <Button variant="secondary" onClick={() => setTransferTarget(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      )}

      {viewerRole === 'leader' && (
        <Card className="p-6 border-[rgba(255,107,107,0.4)]">
          <h2 className="text-lg font-medium mb-2 text-wv-red">Danger Zone</h2>
          <p className="text-sm text-wv-dim mb-4">
            Closing the organization is permanent and cannot be undone.
          </p>
          <Button
            variant="primary"
            data-testid="close-org-button"
            onClick={() => setCloseDialogOpen(true)}
          >
            Close Organization
          </Button>

          {closeDialogOpen && (
            <div className="fixed inset-0 bg-wv-bg/70 flex items-center justify-center z-50">
              <Card className="p-6 max-w-sm w-full mx-4">
                <h3 className="text-lg font-medium mb-2">Confirm Close Organization</h3>
                <p className="text-sm text-wv-dim mb-4">
                  This action is irreversible. All members will be removed and the organization will be closed permanently.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    data-testid="close-org-confirm-button"
                    onClick={handleCloseOrg}
                    disabled={closeLoading}
                  >
                    {closeLoading ? 'Closing...' : 'Close Organization'}
                  </Button>
                  <Button variant="secondary" onClick={() => setCloseDialogOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </Card>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
