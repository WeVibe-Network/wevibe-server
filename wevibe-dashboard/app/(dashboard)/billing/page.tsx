'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type MsgSendEncodeObject } from '@cosmjs/stargate'
import { getOrgCredits, getOrgFinances } from '@/lib/hub-client'
import { directBroadcast } from '@/lib/chain-client'
import { copyToClipboard } from '@/lib/copy-error'
import { formatVibeWithDenom } from '@/lib/format'
import { useOrgContext } from '@/lib/org-context'
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast'
import { useDashboardState } from '@/lib/use-dashboard-state'
import { connectWallet } from '@/lib/wallet-connect'
import ClientTime from '@/components/ui/client-time'

const REASON_LABELS: Record<string, string> = {
  topup: 'Credit top-up',
  query: 'Query deduction',
}

const UVIBE_PER_VIBE = 1_000_000

export default function BillingPage() {
  const [hubCredits, setHubCredits] = useState(0)
  const [chainTreasury, setChainTreasury] = useState(0)
  const [orgAccountAddress, setOrgAccountAddress] = useState('')
  const [copiedOrgAccount, setCopiedOrgAccount] = useState(false)
  const [topUpAmount, setTopUpAmount] = useState('')
  const [topUpError, setTopUpError] = useState('')
  const [topUpSubmitting, setTopUpSubmitting] = useState(false)
  const [transactions, setTransactions] = useState<Array<{
    txn_id: number
    delta: number
    reason: string
    actor: string
    created_at: string
  }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const { activeOrg, orgs } = useOrgContext()
  const orgId = activeOrg?.org_id ?? orgs[0]?.org_id ?? ''
  const { isLeader, loading: dashLoading } = useDashboardState()

  useEffect(() => {
    if (!orgId) { setLoading(false); return }
    setLoading(true)
    Promise.all([getOrgFinances(orgId), getOrgCredits(orgId)])
      .then(([finances, credits]) => {
        setHubCredits(finances.hub_credits)
        setChainTreasury(finances.chain_treasury)
        setOrgAccountAddress(finances.org_account_address ?? '')
        setTransactions(credits.transactions ?? [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [orgId])

  const handleCopyOrgAccount = async () => {
    if (!orgAccountAddress) return
    const ok = await copyToClipboard(orgAccountAddress)
    if (!ok) {
      toast.error('Failed to copy address')
      return
    }
    setCopiedOrgAccount(true)
    window.setTimeout(() => setCopiedOrgAccount(false), 2000)
  }

  const handleTopUp = async () => {
    if (topUpSubmitting) return
    setTopUpError('')

    const vibe = Number(topUpAmount)
    if (!Number.isFinite(vibe) || vibe <= 0) {
      setTopUpError('Enter a positive amount of VIBE.')
      return
    }
    const uvibe = Math.round(vibe * UVIBE_PER_VIBE)
    if (uvibe < 1) {
      setTopUpError('Amount is too small (minimum 0.000001 VIBE).')
      return
    }
    if (!orgAccountAddress) {
      setTopUpError('Org account address is not available yet.')
      return
    }

    const toastId = txToast('Top up org account')
    setTopUpSubmitting(true)
    try {
      const wallet = await connectWallet()
      txConfirming(toastId, 'Top up org account')

      const sendMsg: MsgSendEncodeObject = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: wallet.address,
          toAddress: orgAccountAddress,
          amount: [{ denom: 'uvibe', amount: String(uvibe) }],
        },
      }

      // Leader pays their own gas: the org-account feegrant does not cover
      // bank MsgSend, so directBroadcast is called with NO fee granter.
      const result = await directBroadcast(wallet.address, [sendMsg])
      txSuccess(toastId, 'Top-up confirmed on chain.', result.txHash)
      setTopUpAmount('')
    } catch (err) {
      txError(toastId, err instanceof Error ? err.message : String(err))
    } finally {
      setTopUpSubmitting(false)
    }
  }

  if (dashLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Billing</h1>
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <p className="text-sm text-wv-dim">Loading…</p>
        </div>
      </div>
    )
  }

  if (!isLeader) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-wv-text">Billing</h1>
        <div className="rounded-xl border border-wv-line bg-wv-panel p-6">
          <p className="text-sm text-wv-amber">Billing is leader-only.</p>
        </div>
      </div>
    )
  }

  if (!orgId) return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Billing</h1>
      <p className="text-sm text-wv-amber bg-[rgba(255,178,85,0.12)] border border-[rgba(255,178,85,0.4)] rounded-lg p-4">
        Select or join an organization first.
      </p>
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <button
          onClick={() => alert('Stripe integration coming soon')}
          className="text-sm px-4 py-1.5 bg-wv-grad-btn text-white rounded border border-[rgba(124,92,255,0.4)] hover:opacity-95"
        >
          Top Up Credits
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-[rgba(255,107,107,0.12)] border border-[rgba(255,107,107,0.4)] rounded-lg p-3 text-wv-red text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-wv-faint text-sm">Loading...</p>
      ) : (
        <>
          <div className="grid gap-4 mb-6 sm:grid-cols-2 lg:grid-cols-3">
            <div className="bg-wv-panel border border-wv-line rounded-lg p-6 shadow-wv-sm">
              <p className="text-sm font-mono text-wv-dim tracking-[0.08em] uppercase mb-1">Hub Credits (off-chain)</p>
              <p className="text-3xl font-semibold tracking-[-0.02em] text-wv-text font-mono">{hubCredits.toLocaleString()} credits</p>
            </div>
            <div className="bg-wv-panel border border-wv-line rounded-lg p-6 shadow-wv-sm">
              <p className="text-sm font-mono text-wv-dim tracking-[0.08em] uppercase mb-1">Chain Treasury (on-chain retrieval budget)</p>
              <p className="text-3xl font-semibold tracking-[-0.02em] text-wv-text font-mono">{formatVibeWithDenom(chainTreasury)}</p>
            </div>
            <div className="bg-wv-panel border border-wv-line rounded-lg p-6 shadow-wv-sm">
              <p className="text-sm font-mono text-wv-dim tracking-[0.08em] uppercase mb-1">Org account address</p>
              <p className="font-mono text-sm text-wv-text break-all">{orgAccountAddress || '—'}</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={handleCopyOrgAccount}
                  disabled={!orgAccountAddress || copiedOrgAccount}
                  className="inline-flex items-center justify-center rounded-lg border border-wv-line-2 px-3 py-1.5 text-xs font-medium text-wv-text transition hover:border-[rgba(124,92,255,0.35)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {copiedOrgAccount ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="mt-4 border-t border-wv-line pt-4">
                <p className="text-xs font-mono text-wv-dim tracking-[0.08em] uppercase mb-2">Top up from your wallet</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={topUpAmount}
                    onChange={(e) => setTopUpAmount(e.target.value)}
                    placeholder="Amount (VIBE)"
                    disabled={topUpSubmitting}
                    className="w-full min-w-0 rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-1.5 font-mono text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  />
                  <button
                    type="button"
                    onClick={handleTopUp}
                    disabled={topUpSubmitting || !orgAccountAddress}
                    className="inline-flex shrink-0 items-center justify-center rounded-lg bg-wv-grad-btn px-4 py-1.5 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
                  >
                    {topUpSubmitting ? 'Sending…' : 'Top up'}
                  </button>
                </div>
                {topUpError && <p className="mt-2 text-xs text-wv-red">{topUpError}</p>}
              </div>
            </div>
          </div>

          <div className="bg-wv-panel border border-wv-line rounded-lg overflow-hidden shadow-wv-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-wv-line bg-wv-panel-2">
                  <th className="text-left px-4 py-3 text-xs font-mono font-medium uppercase tracking-[0.08em] text-wv-dim">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-mono font-medium uppercase tracking-[0.08em] text-wv-dim">Reason</th>
                  <th className="text-left px-4 py-3 text-xs font-mono font-medium uppercase tracking-[0.08em] text-wv-dim">Actor</th>
                  <th className="text-left px-4 py-3 text-xs font-mono font-medium uppercase tracking-[0.08em] text-wv-dim">Date</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr key={t.txn_id ?? i} className="border-b border-wv-line last:border-0">
                    <td className="px-4 py-3">
                      <span className={`font-mono font-medium ${t.delta >= 0 ? 'text-wv-green' : 'text-wv-red'}`}>
                        {(t.delta ?? 0) >= 0 ? '+' : ''}{(t.delta ?? 0).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-wv-dim">
                      {REASON_LABELS[t.reason] ?? t.reason}
                    </td>
                    <td className="px-4 py-3 text-wv-dim text-xs font-mono">
                      {t.actor}
                    </td>
                    <td className="px-4 py-3 text-wv-faint text-xs font-mono">
                      {t.created_at ? <ClientTime value={t.created_at} mode="datetime" /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {transactions.length === 0 && (
              <p className="text-center py-8 text-wv-faint">No transactions yet</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
