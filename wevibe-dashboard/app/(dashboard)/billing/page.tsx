'use client'
import { useEffect, useState } from 'react'
import { getOrgCredits, getOrgFinances } from '@/lib/hub-client'
import { useOrgContext } from '@/lib/org-context'
import ClientTime from '@/components/ui/client-time'

const REASON_LABELS: Record<string, string> = {
  topup: 'Credit top-up',
  query: 'Query deduction',
}

export default function BillingPage() {
  const [hubCredits, setHubCredits] = useState(0)
  const [chainTreasury, setChainTreasury] = useState(0)
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

  useEffect(() => {
    if (!orgId) { setLoading(false); return }
    setLoading(true)
    Promise.all([getOrgFinances(orgId), getOrgCredits(orgId)])
      .then(([finances, credits]) => {
        setHubCredits(finances.hub_credits)
        setChainTreasury(finances.chain_treasury)
        setTransactions(credits.transactions ?? [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [orgId])

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
          <div className="grid gap-4 mb-6 sm:grid-cols-2">
            <div className="bg-wv-panel border border-wv-line rounded-lg p-6 shadow-wv-sm">
              <p className="text-sm font-mono text-wv-dim tracking-[0.08em] uppercase mb-1">Hub Credits (off-chain)</p>
              <p className="text-3xl font-semibold tracking-[-0.02em] text-wv-text font-mono">{hubCredits.toLocaleString()} credits</p>
            </div>
            <div className="bg-wv-panel border border-wv-line rounded-lg p-6 shadow-wv-sm">
              <p className="text-sm font-mono text-wv-dim tracking-[0.08em] uppercase mb-1">Chain Treasury (on-chain retrieval budget)</p>
              <p className="text-3xl font-semibold tracking-[-0.02em] text-wv-text font-mono">{chainTreasury.toLocaleString()} uvibe</p>
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
