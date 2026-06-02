'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { listMembers, transferLeadership, closeOrg, getOrg, type MemberRecord } from '@/lib/hub-client'
import { getIdentity } from '@/lib/wevibe-auth'
import { relayBroadcast } from '@/lib/relay-client'
import { connectWallet } from '@/lib/wallet-connect'
import type { EncodeObject } from '@/lib/chain-client'
import type { OrgRole } from '@/lib/org-role'
import Button from '@/components/ui/button'
import Card from '@/components/ui/card'

const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID ?? ''

const ROLE_COLORS: Record<string, string> = {
  leader:    'bg-purple-100 text-purple-700',
  moderator: 'bg-blue-100 text-blue-700',
  member:    'bg-gray-100 text-gray-600',
}

type ViewerRole = OrgRole

export default function MembersPage() {
  const router = useRouter()
  const [members, setMembers] = useState<MemberRecord[]>([])
  const [viewerPubkey, setViewerPubkey] = useState<string>('')
  const [viewerRole, setViewerRole] = useState<ViewerRole>('member')
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  const [invitePubkey, setInvitePubkey] = useState('')
  const [inviteX25519Pubkey, setInviteX25519Pubkey] = useState('')
  const [inviteRole, setInviteRole] = useState<'moderator' | 'member'>('member')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState('')

  const [roleChangeTarget, setRoleChangeTarget] = useState<string | null>(null)
  const [roleChangeLoading, setRoleChangeLoading] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)

  const [transferTarget, setTransferTarget] = useState<string | null>(null)
  const [transferLoading, setTransferLoading] = useState(false)

  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeLoading, setCloseLoading] = useState(false)

  async function refreshMembers() {
    setLoading(true)
    setError('')
    try {
      const data = await listMembers(ORG_ID)
      setMembers(data ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!ORG_ID) { setLoading(false); return }
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
  }, [router])

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
    try {
      const walletConn = await connectWallet()
      const msgAddMember = {
        typeUrl: '/wevibe.org.v1.MsgAddMember',
        value: Buffer.from(JSON.stringify({
          signer: walletConn.address,
          org_id: ORG_ID,
          pubkey: invitePubkey,
          role: inviteRole,
        })),
      } as unknown as EncodeObject;
      await relayBroadcast(ORG_ID, walletConn.address, [msgAddMember])
      setInviteSuccess(`Invited ${invitePubkey.slice(0, 12)}... as ${inviteRole}`)
      setInvitePubkey('')
      setInviteX25519Pubkey('')
      setInviteRole('member')
      await refreshMembers()
    } catch (err) {
      setInviteError((err as Error).message)
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleRoleChange(pubkey: string, newRole: string) {
    setRoleChangeLoading(true)
    try {
      const walletConn = await connectWallet()
      const msgUpdateMemberRole = {
        typeUrl: '/wevibe.org.v1.MsgUpdateMemberRole',
        value: Buffer.from(JSON.stringify({
          signer: walletConn.address,
          org_id: ORG_ID,
          pubkey,
          new_role: newRole,
        })),
      } as unknown as EncodeObject;
      await relayBroadcast(ORG_ID, walletConn.address, [msgUpdateMemberRole])
      setRoleChangeTarget(null)
      await refreshMembers()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRoleChangeLoading(false)
    }
  }

  async function handleRemove(pubkey: string) {
    setRemoveLoading(true)
    try {
      const walletConn = await connectWallet()
      const msgRemoveMember = {
        typeUrl: '/wevibe.org.v1.MsgRemoveMember',
        value: Buffer.from(JSON.stringify({
          signer: walletConn.address,
          org_id: ORG_ID,
          pubkey,
        })),
      } as unknown as EncodeObject;
      await relayBroadcast(ORG_ID, walletConn.address, [msgRemoveMember])
      setRemoveTarget(null)
      await refreshMembers()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRemoveLoading(false)
    }
  }

  async function handleTransfer(pubkey: string) {
    setTransferLoading(true)
    try {
      await transferLeadership(ORG_ID, pubkey)
      setTransferTarget(null)
      await refreshMembers()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setTransferLoading(false)
    }
  }

  async function handleCloseOrg() {
    setCloseLoading(true)
    try {
      await closeOrg(ORG_ID)
      setCloseDialogOpen(false)
      await refreshMembers()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCloseLoading(false)
    }
  }

  if (!ORG_ID) return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Members</h1>
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-4">
        Set <code>NEXT_PUBLIC_ORG_ID</code> in <code>.env.local</code>.
      </p>
    </div>
  )

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Members</h1>
      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {viewerRole === 'leader' && (
        <Card className="p-6">
          <h2 className="text-lg font-medium mb-4">Invite Member</h2>
          <form onSubmit={handleInvite} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Public Key</label>
                <input
                  type="text"
                  data-testid="invite-pubkey-input"
                  value={invitePubkey}
                  onChange={e => setInvitePubkey(e.target.value)}
                  placeholder="0000..."
                  required
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">X25519 Public Key</label>
                <input
                  type="text"
                  data-testid="invite-x25519-input"
                  value={inviteX25519Pubkey}
                  onChange={e => setInviteX25519Pubkey(e.target.value)}
                  placeholder="0000..."
                  required
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  data-testid="invite-role-select"
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as 'moderator' | 'member')}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="member">Member</option>
                  <option value="moderator">Moderator</option>
                </select>
              </div>
            </div>
            {inviteError && <p className="text-red-600 text-sm">{inviteError}</p>}
            {inviteSuccess && <p className="text-green-600 text-sm">{inviteSuccess}</p>}
            <div>
              <Button type="submit" disabled={inviteLoading} data-testid="invite-submit-button">
                {inviteLoading ? 'Inviting...' : 'Invite Member'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? <p className="text-gray-400 text-sm">Loading...</p> : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Member</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Epoch</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Dismissed</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Joined</th>
                {viewerRole === 'leader' && <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.pubkey} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-xs">
                    <p className="font-medium text-gray-900" title={m.wallet_address || m.pubkey}>{m.display_name || 'Unnamed'}</p>
                    <p className="font-mono text-gray-500">{m.pubkey.slice(0, 20)}…</p>
                  </td>
                  <td className="px-4 py-3">
                    {roleChangeTarget === m.pubkey ? (
                      <select
                        data-testid="role-change-select"
                        defaultValue={m.role}
                        onChange={e => handleRoleChange(m.pubkey, e.target.value)}
                        onBlur={() => setRoleChangeTarget(null)}
                        autoFocus
                        className="rounded border border-gray-300 px-2 py-1 text-xs"
                      >
                        <option value="moderator">Moderator</option>
                        <option value="member">Member</option>
                      </select>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${ROLE_COLORS[m.role] ?? 'bg-gray-100 text-gray-600'}`}>
                        {m.role}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{m.join_epoch}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${m.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                      {m.active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(m.dismissed_reports_count ?? 0) > 0 ? (
                      <span className="text-amber-600 font-medium">{m.dismissed_reports_count}</span>
                    ) : (
                      <span className="text-gray-300">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(m.joined_at).toLocaleDateString()}
                  </td>
                  {viewerRole === 'leader' && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          data-testid="role-change-trigger"
                          onClick={() => setRoleChangeTarget(m.pubkey)}
                          disabled={roleChangeLoading || m.role === 'leader'}
                          className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 disabled:pointer-events-none"
                        >
                          Change Role
                        </button>
                        <button
                          data-testid="remove-member-trigger"
                          onClick={() => setRemoveTarget(m.pubkey)}
                          disabled={removeLoading || m.role === 'leader'}
                          className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50 disabled:pointer-events-none"
                        >
                          Remove
                        </button>
                        <button
                          data-testid="transfer-leadership-trigger"
                          onClick={() => setTransferTarget(m.pubkey)}
                          disabled={transferLoading || m.role === 'leader'}
                          className="text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50 disabled:pointer-events-none"
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
            <p className="text-center py-8 text-gray-400">No members found</p>
          )}
        </div>
      )}

      {removeTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-medium mb-2">Remove Member</h3>
            <p className="text-sm text-gray-600 mb-4">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-medium mb-2">Transfer Leadership</h3>
            <p className="text-sm text-gray-600 mb-4">
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
        <Card className="p-6 border-red-200">
          <h2 className="text-lg font-medium mb-2 text-red-700">Danger Zone</h2>
          <p className="text-sm text-gray-600 mb-4">
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
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="p-6 max-w-sm w-full mx-4">
                <h3 className="text-lg font-medium mb-2">Confirm Close Organization</h3>
                <p className="text-sm text-gray-600 mb-4">
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
