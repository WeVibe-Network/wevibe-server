'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { listMembers, enableMemberRecall, disableMemberRecall, type MemberRecord } from '@/lib/hub-client'
import { getIdentity } from '@/lib/wevibe-auth'
import { connectWallet } from '@/lib/wallet-connect'
import {
  buildAddMemberMsg,
  buildCloseOrgMsg,
  buildRemoveMemberMsg,
  buildSetMemberCapabilitiesMsg,
  directBroadcast,
  getOrgAccountAddress,
} from '@/lib/chain-client'
import { useOrgContext } from '@/lib/org-context'
import { useDashboardState } from '@/lib/use-dashboard-state'
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast'
import Button from '@/components/ui/button'
import Card from '@/components/ui/card'
import ClientTime from '@/components/ui/client-time'

type MemberCapabilities = { can_contribute: boolean; can_moderate: boolean }

export default function MembersPage() {
  const router = useRouter()
  const { activeOrg } = useOrgContext()
  const { isLeader } = useDashboardState()
  const orgId = activeOrg?.org_id ?? ''
  const [members, setMembers] = useState<MemberRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  const [invitePubkey, setInvitePubkey] = useState('')
  const [inviteX25519Pubkey, setInviteX25519Pubkey] = useState('')
  const [inviteCanContribute, setInviteCanContribute] = useState(false)
  const [inviteCanModerate, setInviteCanModerate] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState('')

  const [stagedCaps, setStagedCaps] = useState<Record<string, MemberCapabilities>>({})
  const [capSavingTarget, setCapSavingTarget] = useState<string | null>(null)

  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)

  const [enableRecallTarget, setEnableRecallTarget] = useState<string | null>(null)

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
      await refreshMembers()
    })().catch((err) => {
      setError((err as Error).message)
      setLoading(false)
    })
  }, [orgId, router])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviteLoading(true)
    setInviteError('')
    setInviteSuccess('')
    const id = txToast('Invite')
    try {
      const walletConn = await connectWallet()
      txConfirming(id, 'Invite')
      const msgAddMember = buildAddMemberMsg(
        walletConn.address,
        orgId,
        invitePubkey,
        'member',
        inviteX25519Pubkey,
        inviteCanContribute,
        inviteCanModerate,
      )
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msgAddMember], orgAccount)
      const successMessage = `Invited ${invitePubkey.slice(0, 12)}…`
      txSuccess(id, successMessage, result.txHash)
      setInviteSuccess(successMessage)
      setInvitePubkey('')
      setInviteX25519Pubkey('')
      setInviteCanContribute(false)
      setInviteCanModerate(false)
      await refreshMembers()
      setInviteSuccess('')
    } catch (err) {
      const message = (err as Error).message
      setInviteError(message)
      txError(id, message)
    } finally {
      setInviteLoading(false)
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

  function getBaseCapabilities(member: MemberRecord): MemberCapabilities {
    return {
      can_contribute: !!member.can_contribute,
      can_moderate: !!member.can_moderate,
    }
  }

  function getEffectiveCapabilities(member: MemberRecord): MemberCapabilities {
    return stagedCaps[member.pubkey] ?? getBaseCapabilities(member)
  }

  function toggleStagedCapability(member: MemberRecord, key: keyof MemberCapabilities) {
    setStagedCaps((prev) => {
      const current = prev[member.pubkey] ?? getBaseCapabilities(member)
      return {
        ...prev,
        [member.pubkey]: {
          ...current,
          [key]: !current[key],
        },
      }
    })
  }

  function isCapabilityRowDirty(member: MemberRecord): boolean {
    const base = getBaseCapabilities(member)
    const effective = getEffectiveCapabilities(member)
    return (
      base.can_contribute !== effective.can_contribute ||
      base.can_moderate !== effective.can_moderate
    )
  }

  async function handleApproveCapabilities(member: MemberRecord) {
    const eff = stagedCaps[member.pubkey] ?? {
      can_contribute: !!member.can_contribute,
      can_moderate: !!member.can_moderate,
    }
    setCapSavingTarget(member.pubkey)
    const id = txToast('Capabilities')
    try {
      const walletConn = await connectWallet()
      txConfirming(id, 'Capabilities')
      const msg = buildSetMemberCapabilitiesMsg(
        walletConn.address,
        orgId,
        member.pubkey,
        eff.can_contribute,
        eff.can_moderate,
      )
      const orgAccount = await resolveOrgAccountForGas()
      const result = await directBroadcast(walletConn.address, [msg], orgAccount)
      setStagedCaps((prev) => {
        const next = { ...prev }
        delete next[member.pubkey]
        return next
      })
      await refreshMembers()
      txSuccess(id, 'Capabilities updated', result.txHash)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      txError(id, message)
    } finally {
      setCapSavingTarget(null)
    }
  }

  async function handleEnableRecall(pubkey: string) {
    setEnableRecallTarget(pubkey)
    setError('')
    const id = toast.loading('Enabling free recall…')
    try {
      await enableMemberRecall(orgId, pubkey, true)
      await refreshMembers()
      toast.success('Free recall enabled for this member', { id })
    } catch (err) {
      const status = typeof err === 'object' && err !== null
        ? (err as { status?: number }).status
        : undefined
      if (status === 402) {
        setError('Org has insufficient credits to enable free recall')
        toast.error('Org has insufficient recall credits — top up to enable free recall.', { id })
      } else {
        const message = (err as Error).message
        setError(message)
        toast.error(message, { id })
      }
    } finally {
      setEnableRecallTarget(null)
    }
  }

  async function handleDisableRecall(pubkey: string) {
    setEnableRecallTarget(pubkey)
    setError('')
    const id = toast.loading('Disabling recall…')
    try {
      await disableMemberRecall(orgId, pubkey)
      await refreshMembers()
      toast.success('Recall disabled for this member', { id })
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      toast.error(message, { id })
    } finally {
      setEnableRecallTarget(null)
    }
  }

  function truncateIdentity(value: string): string {
    const trimmed = value.trim()
    return trimmed.length > 12 ? `${trimmed.slice(0, 12)}…` : trimmed
  }

  function getMemberIdentity(member: MemberRecord): string {
    const displayName = member.display_name?.trim()
    if (displayName) {
      return displayName
    }

    const walletAddress = member.wallet_address?.trim()
    if (walletAddress) {
      return truncateIdentity(walletAddress)
    }

    return truncateIdentity(member.pubkey)
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

  const removeMember = removeTarget ? members.find((member) => member.pubkey === removeTarget) : null
  const removeIdentity = removeMember
    ? getMemberIdentity(removeMember)
    : removeTarget
      ? truncateIdentity(removeTarget)
      : ''

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Members</h1>
      {error && <p className="text-wv-red text-sm mb-4">{error}</p>}

      {isLeader && (
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
                <label className="block text-sm font-medium text-wv-text mb-1">Capabilities</label>
                <div className="w-full bg-wv-panel-2 border border-wv-line-2 rounded-[11px] px-3 py-2 space-y-2">
                  <label className="flex items-center gap-2 text-sm text-wv-text">
                    <input
                      type="checkbox"
                      data-testid="invite-can-contribute"
                      checked={inviteCanContribute}
                      onChange={(e) => setInviteCanContribute(e.target.checked)}
                      className="h-4 w-4 rounded border border-wv-line-2 bg-wv-panel accent-wv-violet"
                    />
                    <span>Can contribute</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-wv-text">
                    <input
                      type="checkbox"
                      data-testid="invite-can-moderate"
                      checked={inviteCanModerate}
                      onChange={(e) => setInviteCanModerate(e.target.checked)}
                      className="h-4 w-4 rounded border border-wv-line-2 bg-wv-panel accent-wv-violet"
                    />
                    <span>Can moderate</span>
                  </label>
                </div>
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
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Capabilities</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Epoch</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Status</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Dismissed</th>
                <th className="text-left px-4 py-3 font-medium text-wv-dim">Joined</th>
                {isLeader && <th className="text-left px-4 py-3 font-medium text-wv-dim">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const effectiveCaps = getEffectiveCapabilities(m)
                const capsDirty = isCapabilityRowDirty(m)
                const isLeaderRow = m.role === 'leader'
                const canManageCaps = isLeader && !isLeaderRow
                const isSavingCaps = capSavingTarget === m.pubkey

                return (
                  <tr key={m.pubkey} className="border-b border-wv-line last:border-0">
                    <td className="px-4 py-3 text-xs">
                      <div className="flex items-start gap-2">
                        {isLeader && !isLeaderRow && (
                          <button
                            type="button"
                            data-testid="remove-member-trigger"
                            onClick={() => setRemoveTarget(m.pubkey)}
                            disabled={removeLoading}
                            title="Remove member"
                            className="mt-0.5 text-base leading-none text-wv-red hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                          >
                            🚫
                          </button>
                        )}
                        <div>
                          <p className="font-medium text-wv-text" title={m.wallet_address || m.pubkey}>{m.display_name || 'Unnamed'}</p>
                          <p className="font-mono text-wv-dim">{m.pubkey.slice(0, 20)}…</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {isLeaderRow ? (
                        <span className="inline-flex text-xs px-2 py-0.5 rounded font-medium bg-[rgba(124,92,255,0.14)] text-wv-violet">
                          Leader
                        </span>
                      ) : (
                        <div className="inline-flex items-center rounded-[10px] border border-wv-line-2 bg-wv-panel-2 px-2 py-1">
                          <div className="grid grid-cols-2 gap-1 opacity-60">
                            <button
                              type="button"
                              data-testid={effectiveCaps.can_contribute ? 'cap-pill-contribute' : undefined}
                              onClick={() => toggleStagedCapability(m, 'can_contribute')}
                              disabled={!canManageCaps || isSavingCaps}
                              style={{ visibility: effectiveCaps.can_contribute ? 'visible' : 'hidden' }}
                              className={`w-[92px] rounded-full border border-wv-line px-2 py-1 text-[11px] font-medium text-center text-wv-text transition ${effectiveCaps.can_contribute ? 'bg-wv-panel hover:border-wv-violet' : 'pointer-events-none'} disabled:opacity-50 disabled:pointer-events-none`}
                            >
                              Contribute
                            </button>
                            <button
                              type="button"
                              data-testid={effectiveCaps.can_moderate ? 'cap-pill-moderate' : undefined}
                              onClick={() => toggleStagedCapability(m, 'can_moderate')}
                              disabled={!canManageCaps || isSavingCaps}
                              style={{ visibility: effectiveCaps.can_moderate ? 'visible' : 'hidden' }}
                              className={`w-[92px] rounded-full border border-wv-line px-2 py-1 text-[11px] font-medium text-center text-wv-text transition ${effectiveCaps.can_moderate ? 'bg-wv-panel hover:border-wv-violet' : 'pointer-events-none'} disabled:opacity-50 disabled:pointer-events-none`}
                            >
                              Moderate
                            </button>
                          </div>
                          <span className="mx-1 text-xs text-wv-faint select-none">|</span>
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              type="button"
                              data-testid={!effectiveCaps.can_contribute ? 'cap-pill-contribute' : undefined}
                              onClick={() => toggleStagedCapability(m, 'can_contribute')}
                              disabled={!canManageCaps || isSavingCaps}
                              style={{ visibility: !effectiveCaps.can_contribute ? 'visible' : 'hidden' }}
                              className={`w-[92px] rounded-full border border-wv-line px-2 py-1 text-[11px] font-medium text-center text-wv-text transition ${!effectiveCaps.can_contribute ? 'bg-wv-panel hover:border-wv-violet' : 'pointer-events-none'} disabled:opacity-50 disabled:pointer-events-none`}
                            >
                              Contribute
                            </button>
                            <button
                              type="button"
                              data-testid={!effectiveCaps.can_moderate ? 'cap-pill-moderate' : undefined}
                              onClick={() => toggleStagedCapability(m, 'can_moderate')}
                              disabled={!canManageCaps || isSavingCaps}
                              style={{ visibility: !effectiveCaps.can_moderate ? 'visible' : 'hidden' }}
                              className={`w-[92px] rounded-full border border-wv-line px-2 py-1 text-[11px] font-medium text-center text-wv-text transition ${!effectiveCaps.can_moderate ? 'bg-wv-panel hover:border-wv-violet' : 'pointer-events-none'} disabled:opacity-50 disabled:pointer-events-none`}
                            >
                              Moderate
                            </button>
                          </div>
                        </div>
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
                    {isLeader && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {m.membership_active ? (
                            <button
                              data-testid="disable-recall-trigger"
                              onClick={() => handleDisableRecall(m.pubkey)}
                              disabled={enableRecallTarget === m.pubkey}
                              className="text-xs text-wv-red hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                            >
                              {enableRecallTarget === m.pubkey ? 'Disabling...' : 'Disable recall'}
                            </button>
                          ) : (
                            !m.is_trial && (
                              <button
                                data-testid="enable-recall-trigger"
                                onClick={() => handleEnableRecall(m.pubkey)}
                                disabled={enableRecallTarget === m.pubkey}
                                className="text-xs text-wv-green hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                              >
                                {enableRecallTarget === m.pubkey ? 'Enabling...' : 'Enable free recall'}
                              </button>
                            )
                          )}
                          {!isLeaderRow && (
                            <button
                              type="button"
                              data-testid="cap-approve-button"
                              onClick={() => handleApproveCapabilities(m)}
                              disabled={!capsDirty || isSavingCaps}
                              className="text-xs text-wv-violet hover:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
                            >
                              {isSavingCaps ? 'Saving...' : 'Approve'}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
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
              Are you sure you want to remove {removeIdentity} from the org? WARNING: this action cannot be undone.
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

      {isLeader && (
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
