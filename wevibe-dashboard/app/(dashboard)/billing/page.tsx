'use client'
import { useEffect, useState } from 'react'
import { getOrgCredits, getOrgFinances } from '@/lib/hub-client'
import { useOrgContext } from '@/lib/org-context'

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
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-4">
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
          className="text-sm px-4 py-1.5 bg-blue-600 text-white rounded border border-blue-600 hover:bg-blue-700"
        >
          Top Up Credits
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">Loading...</p>
      ) : (
        <>
          <div className="grid gap-4 mb-6 sm:grid-cols-2">
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <p className="text-sm text-gray-500 mb-1">Hub Credits (off-chain)</p>
              <p className="text-3xl font-semibold text-gray-900">{hubCredits.toLocaleString()} credits</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <p className="text-sm text-gray-500 mb-1">Chain Treasury (on-chain retrieval budget)</p>
              <p className="text-3xl font-semibold text-gray-900">{chainTreasury.toLocaleString()} uvibe</p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Reason</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Actor</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr key={t.txn_id ?? i} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3">
                      <span className={`font-medium ${t.delta >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                        {(t.delta ?? 0) >= 0 ? '+' : ''}{(t.delta ?? 0).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {REASON_LABELS[t.reason] ?? t.reason}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs font-mono">
                      {t.actor}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {t.created_at ? new Date(t.created_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {transactions.length === 0 && (
              <p className="text-center py-8 text-gray-400">No transactions yet</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
