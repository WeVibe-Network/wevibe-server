'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  getSubmissionsByStatus,
  submitKeywordResults,
  verifyKeywords,
  rerunKeywords,
  updateKeywords,
  removeSubmission,
  getOrgHealth,
  prepareBatchSubmit,
  type Submission,
  type KeywordWeight,
  type OrgHealth,
  type VerificationResult,
  type SanitizationFinding,
} from '@/lib/hub-client';
import { getMcpClient, ConnectionState } from '@/lib/mcp-client';
import {
  buildApproveMemoryMsg,
  buildDenialBatchMsg,
  buildSubmitCommitmentMsg,
  relayOrgDecision,
} from '@/lib/chain-client';
import ClientTime from '@/components/ui/client-time';
import { getConfig } from '@/lib/config';
import { useOrgContext } from '@/lib/org-context';

type MemoryKeywordResult = {
  submission_hash: string;
  classified: KeywordWeight[];
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) {
    throw new Error('invalid hex input length');
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

export default function ChainSubmitPage() {
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id ?? '';

  const [orgHealth, setOrgHealth] = useState<OrgHealth | null>(null);
  const [pendingKeyword, setPendingKeyword] = useState<Submission[]>([]);
  const [reviewKeywords, setReviewKeywords] = useState<Submission[]>([]);
  const [pendingChain, setPendingChain] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [verifyResults, setVerifyResults] = useState<VerificationResult[] | null>(null);
  const [txResult, setTxResult] = useState<{ tx_hash: string; committed_count: number } | null>(null);
  const [pendingDenialCount, setPendingDenialCount] = useState<number>(0);
  const [denialSubmitting, setDenialSubmitting] = useState(false);
  const [denialResult, setDenialResult] = useState<{ txHash?: string; error?: string } | null>(null);

  const clientRef = { current: getMcpClient() };

  const loadAll = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const HUB_URL = getConfig().hubUrl;
      const authHeaders = { 'Authorization': `Bearer ${localStorage.getItem('wevibe_token') ?? ''}` };
      const [health, pk, rk, pc] = await Promise.all([
        getOrgHealth(orgId),
        getSubmissionsByStatus(orgId, 'pending_keyword'),
        getSubmissionsByStatus(orgId, 'pending_keyword'),
        getSubmissionsByStatus(orgId, 'pending_chain'),
      ]);
      setOrgHealth(health);
      const reviewable = rk.filter(s => s.extraction_result && s.extraction_result.length > 0);
      setPendingKeyword(pk.filter(s => !s.extraction_result || s.extraction_result.length === 0));
      setReviewKeywords(reviewable);
      setPendingChain(pc);
      const denialCountRes = await fetch(`${HUB_URL}/v1/orgs/${orgId}/denials/pending-count`, { headers: authHeaders });
      if (denialCountRes.ok) {
        const data = await denialCountRes.json();
        setPendingDenialCount(data.pending_count ?? 0);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setClientState(getMcpClient().state);
    getMcpClient().addStateListener(setClientState);
  }, []);

  useEffect(() => {
    if (!orgId) return;
    if (clientState === 'connected') {
      void loadAll();
    }
  }, [clientState, loadAll, orgId]);

  const runKeywordExtraction = useCallback(async () => {
    if (!orgId) return;
    const client = getMcpClient();
    if (client.state !== 'connected') {
      setError('Connect to the MCP server to run keyword extraction.');
      return;
    }

    setBusy('extraction');
    setError(null);
    setNotice(null);

    try {
      const toProcess = pendingKeyword.length > 0 ? pendingKeyword : reviewKeywords;
      if (toProcess.length === 0) {
        setNotice('No memories pending keyword extraction.');
        return;
      }

      const plaintexts = toProcess.map(s => s.plaintext ?? '');
      const result = await client.callTool<{ results: MemoryKeywordResult[] }>('wevibe_extract_keywords_batch', { plaintexts });

      if (result.results && result.results.length > 0) {
        const mapped: MemoryKeywordResult[] = toProcess.map((s, i) => ({
          submission_hash: s.submission_hash,
          classified: result.results[i]?.classified ?? [],
        }));
        await submitKeywordResults(orgId, mapped);
        setNotice(`Keyword extraction complete for ${mapped.length} memories.`);
      } else {
        setNotice('No keywords extracted.');
      }

      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [pendingKeyword, reviewKeywords, loadAll, orgId]);

  const handleVerifyAll = useCallback(async () => {
    if (!orgId) return;
    if (reviewKeywords.length === 0) return;

    setBusy('verify');
    setError(null);
    setVerifyResults(null);

    try {
      const hashes = reviewKeywords.map(s => s.submission_hash);
      const results = await verifyKeywords(orgId, hashes);
      setVerifyResults(results);
      const allPassed = results.every(r => r.passed);
      if (allPassed) {
        setNotice('All keywords verified successfully.');
      } else {
        setError('Some verifications failed. Check results below.');
      }
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [reviewKeywords, loadAll, orgId]);

  const handleRerun = useCallback(async (hash: string) => {
    if (!orgId) return;
    const feedback = window.prompt('Provide feedback for rerun:');
    if (!feedback) return;

    setBusy(hash);
    setError(null);

    try {
      await rerunKeywords(orgId, hash, feedback);
      setNotice(`Rerun requested for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleUpdateKeywords = useCallback(async (hash: string, current: KeywordWeight[]) => {
    if (!orgId) return;
    const input = window.prompt('Enter keywords as JSON array [{"keyword":"term","weight":0.9}]:', JSON.stringify(current));
    if (!input) return;

    try {
      const parsed = JSON.parse(input) as KeywordWeight[];
      await updateKeywords(orgId, hash, parsed);
      setNotice(`Keywords updated for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadAll, orgId]);

  const handleRemove = useCallback(async (hash: string) => {
    if (!orgId) return;
    if (!window.confirm(`Remove submission ${hash.slice(0, 12)}…? This cannot be undone.`)) return;

    setBusy(hash);
    setError(null);

    try {
      await removeSubmission(orgId, hash);
      setNotice(`Removed ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleSubmitBatch = useCallback(async () => {
    if (!orgId) return;
    if (pendingChain.length === 0) return;

    const { connectWallet } = await import('@/lib/wallet-connect');
    const walletConnection = await connectWallet().catch(() => null);
    const walletAddress = walletConnection?.address ?? null;
    if (!walletAddress) {
      setError('No wallet connected');
      return;
    }

    setBusy('chain');
    setError(null);
    setTxResult(null);
    setNotice(null);

    try {
      const prepared = await prepareBatchSubmit(orgId);
      if (!prepared.batch || prepared.batch.length === 0) {
        setNotice('No pending serves to submit');
        setBusy(null);
        return;
      }

      const msgs = prepared.batch.flatMap((entry) => {
        const contentHash = hexToBytes(entry.submission_hash);
        const commitment = buildSubmitCommitmentMsg(
          walletAddress,
          orgId,
          contentHash,
          entry.keywords.map((keyword) => ({ keyword, weight: '1.0' })),
          entry.contributor_pubkey,
          entry.contributor_wallet,
          entry.memory_type,
        );
        const approval = buildApproveMemoryMsg(
          walletAddress,
          orgId,
          contentHash,
          hexToBytes(entry.encrypted_blob),
          entry.committing_leader,
          hexToBytes(entry.wrapped_dek_enc),
          hexToBytes(entry.plaintext_hash),
          hexToBytes(entry.salt),
          hexToBytes(entry.ciphertext_hash),
          hexToBytes(entry.contributor_sig),
          entry.memory_type,
        );
        return [commitment, approval];
      });

      const txHash = await relayOrgDecision(orgId, msgs);

      if (txHash) {
        setTxResult({ tx_hash: txHash, committed_count: prepared.batch.length });
        setNotice(null);
      } else {
        setError('Chain submission failed: missing transaction hash');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [orgId, pendingChain]);

  const handleDenialBatchSubmit = useCallback(async () => {
    if (!orgId) return;
    const HUB_URL = getConfig().hubUrl;
    const { connectWallet } = await import('@/lib/wallet-connect');
    const walletConnection = await connectWallet().catch(() => null);
    const walletAddress = walletConnection?.address ?? null;
    if (!walletAddress) {
      setDenialResult({ error: 'No wallet connected' });
      return;
    }
    setDenialSubmitting(true);
    setDenialResult(null);
    try {
      const authHeaders = { 'Authorization': `Bearer ${localStorage.getItem('wevibe_token') ?? ''}` };
      const listRes = await fetch(`${HUB_URL}/v1/orgs/${orgId}/denials/pending`, { headers: authHeaders });
      if (!listRes.ok) throw new Error(`Failed to fetch pending denials: ${listRes.status}`);
      const listData = await listRes.json();
      if (!listData.denials || listData.denials.length === 0) {
        setDenialResult({ error: 'No pending denials to submit' });
        return;
      }
      const epochResp = await fetch(`${HUB_URL}/v1/orgs/${orgId}`, { headers: authHeaders });
      const epochData = await epochResp.json() as { current_epoch?: number };
      const epoch = epochData.current_epoch ?? 0;
      const { directBroadcast } = await import('@/lib/chain-client');
      const msg = buildDenialBatchMsg(
        walletAddress,
        orgId,
        epoch,
        listData.denials.map((d: { nullifier: string; memory_hash: string; deny_key?: string; reason?: string }) => ({
          nullifier: d.nullifier,
          memory_hash: d.memory_hash,
          deny_key: d.deny_key ?? '',
          reason: d.reason ?? '',
        }))
      );
      const result = await directBroadcast(walletAddress, [msg]);
      if (result.code === 0) {
        setDenialResult({ txHash: result.txHash });
        setPendingDenialCount(0);
      } else {
        setDenialResult({ error: `Chain rejected: ${result.rawLog}` });
      }
    } catch (err) {
      setDenialResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setDenialSubmitting(false);
    }
  }, [orgId]);

  if (!orgId) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Batch Pipeline</h1>
          <p className="text-sm text-wv-dim">
            Keyword extraction → Review → Chain submission
          </p>
        </header>
        <div className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 text-sm text-wv-amber">
          No organization selected. Please select an organization first.
        </div>
      </div>
    );
  }

  if (clientState !== 'connected') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Chain Submit</h1>
          <p className="text-sm text-wv-dim">
            Connect to the dashboard MCP server in Settings to manage the batch pipeline.
          </p>
        </header>
        <div className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 text-sm text-wv-amber">
          <p className="font-medium">No MCP session detected ({clientState}).</p>
          <p className="mt-2">
            Open <a href="/settings" className="font-medium text-wv-amber underline-offset-2 hover:underline">Settings</a> and connect to your running `wevibe-mcp --dashboard` server.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Batch Pipeline</h1>
          <p className="mt-1 text-sm text-wv-dim">
            Keyword extraction → Review → Chain submission
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadAll()}
          disabled={loading}
          className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-text shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {orgHealth && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-wv-line bg-wv-panel p-4 shadow-wv-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-wv-dim">Pending Keyword</p>
            <p className="text-2xl font-semibold text-wv-text">{orgHealth.pending_keyword_count}</p>
          </div>
          <div>
            <p className="text-xs text-wv-dim">Pending Chain</p>
            <p className="text-2xl font-semibold text-wv-text">{orgHealth.pending_chain_count}</p>
          </div>
          <div>
            <p className="text-xs text-wv-dim">Last Extraction</p>
            <p className="text-sm font-medium text-wv-text">
              {orgHealth.last_keyword_extraction
                ? <ClientTime value={orgHealth.last_keyword_extraction} mode="datetime" />
                : 'Never'}
            </p>
          </div>
          <div>
            <p className="text-xs text-wv-dim">Last Chain Submit</p>
            <p className="text-sm font-medium text-wv-text">
              {orgHealth.last_chain_submission
                ? <ClientTime value={orgHealth.last_chain_submission} mode="datetime" />
                : 'Never'}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">
          {notice}
        </div>
      )}

      {verifyResults && (
        <div className="rounded-xl border border-wv-line bg-wv-panel p-4">
          <h3 className="font-semibold text-wv-text">Verification Results</h3>
          <div className="mt-2 space-y-1">
            {verifyResults.map(r => (
              <div key={r.submission_hash} className={`font-mono text-sm ${r.passed ? 'text-wv-green' : 'text-wv-red'}`}>
                {r.passed ? '✓' : '✗'} {r.submission_hash.slice(0, 12)}… — {r.passed ? 'Passed' : r.error}
              </div>
            ))}
          </div>
        </div>
      )}

      {txResult && (
        <div className="rounded-xl border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] p-4">
          <h3 className="font-semibold text-wv-green">Batch Submitted</h3>
          <p className="mt-1 text-sm text-wv-green">
            Tx: <span className="font-mono">{txResult.tx_hash}</span>
          </p>
          <p className="text-sm text-wv-green">
            Committed: {txResult.committed_count} memories
          </p>
        </div>
      )}

      <section className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Ready for Keywords</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {pendingKeyword.length} memories approved, awaiting keyword extraction
            </p>
          </div>
          <button
            type="button"
            onClick={() => runKeywordExtraction()}
            disabled={busy === 'extraction' || loading || pendingKeyword.length === 0}
            className="inline-flex items-center rounded-lg bg-wv-amber px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:bg-[rgba(255,178,85,0.85)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {busy === 'extraction' ? 'Extracting…' : 'Run Keyword Extraction'}
          </button>
        </div>

        {pendingKeyword.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories pending keyword extraction.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {pendingKeyword.map(item => (
              <div key={item.submission_hash} className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-wv-panel p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                      <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                      <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                        Epoch {item.epoch_id}
                      </span>
				  <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">
					Memory
				  </span>
                  {item.sanitization_findings && item.sanitization_findings.length > 0 && (
                    <span className="rounded-full bg-[rgba(255,107,107,0.12)] px-2 py-0.5 text-xs font-medium text-wv-red">
                      {item.sanitization_findings.length} content issue(s)
                    </span>
                  )}
                  {item.preference_confidence !== undefined && item.preference_confidence > 0.8 && (
                    <span className="rounded-full bg-[rgba(255,107,107,0.18)] px-2 py-0.5 text-xs font-medium text-wv-red">
                      Likely preference ({(item.preference_confidence * 100).toFixed(0)}%)
                    </span>
                  )}
                  {item.preference_confidence !== undefined && item.preference_confidence > 0.5 && item.preference_confidence <= 0.8 && (
                    <span className="rounded-full bg-[rgba(255,178,85,0.12)] px-2 py-0.5 text-xs font-medium text-wv-amber">
                      Possible preference ({(item.preference_confidence * 100).toFixed(0)}%)
                    </span>
                  )}
                      {item.moderation_approved_by && (
                        <span className="font-mono text-wv-dim">Approved by {item.moderation_approved_by.slice(0, 8)}…</span>
                      )}
                      {item.moderation_approved_at && (
                        <ClientTime value={item.moderation_approved_at} mode="datetime" />
                      )}
                    </div>
                    <p className="mt-2 text-sm text-wv-text line-clamp-2">
                      {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                    </p>
                    {item.extraction_feedback && (
                      <p className="mt-2 text-xs text-wv-amber">
                        Feedback: {item.extraction_feedback}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.12)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Review Keywords</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {reviewKeywords.length} memories with extracted keywords awaiting review
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleVerifyAll()}
            disabled={busy === 'verify' || loading || reviewKeywords.length === 0}
            className="inline-flex items-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {busy === 'verify' ? 'Verifying…' : 'Verify All'}
          </button>
        </div>

        {reviewKeywords.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No keywords to review.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {reviewKeywords.map(item => (
              <div key={item.submission_hash} className="rounded-lg border border-[rgba(124,92,255,0.4)] bg-wv-panel p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                  <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                    Epoch {item.epoch_id}
                  </span>
				  <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">
					Memory
				  </span>
                </div>
                <p className="mt-2 text-sm text-wv-text line-clamp-2">
                  {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                </p>

                {item.extraction_result && item.extraction_result.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-wv-dim">Keywords:</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {item.extraction_result.map((kw, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center rounded-full border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.10)] px-2.5 py-0.5 text-xs font-medium text-wv-violet"
                          title={`Weight: ${(kw.weight * 100).toFixed(0)}%`}
                        >
                          {kw.keyword}
                          <span className="ml-1 text-wv-dim">{(kw.weight * 100).toFixed(0)}%</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {item.extraction_feedback && (
                  <p className="mt-2 text-xs text-wv-amber">
                    Feedback: {item.extraction_feedback}
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleRerun(item.submission_hash)}
                    disabled={busy === item.submission_hash}
                    className="rounded px-2 py-1 text-xs text-wv-amber hover:bg-[rgba(255,178,85,0.12)] disabled:cursor-not-allowed"
                  >
                    Rerun
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUpdateKeywords(item.submission_hash, item.extraction_result ?? [])}
                    disabled={busy === item.submission_hash}
                    className="rounded px-2 py-1 text-xs text-wv-violet hover:bg-[rgba(124,92,255,0.12)] disabled:cursor-not-allowed"
                  >
                    Edit Keywords
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(item.submission_hash)}
                    disabled={busy === item.submission_hash}
                    className="rounded px-2 py-1 text-xs text-wv-red hover:bg-[rgba(255,107,107,0.12)] disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.08)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Pending Denials</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {pendingDenialCount} denial{pendingDenialCount !== 1 ? 's' : ''} queued for chain submission
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleDenialBatchSubmit()}
            disabled={denialSubmitting || !pendingDenialCount}
            className="inline-flex items-center rounded-lg bg-wv-red px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:bg-[rgba(255,107,107,0.85)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {denialSubmitting ? 'Submitting…' : 'Batch Submit Denials'}
          </button>
        </div>

        {pendingDenialCount === 0 && (
          <p className="mt-4 text-sm text-wv-dim">No pending consumer denials.</p>
        )}

        {denialResult?.txHash && (
          <p className="mt-3 text-sm font-mono text-wv-green">
            ✓ Submitted — tx: {denialResult.txHash.slice(0, 16)}…
          </p>
        )}
        {denialResult?.error && (
          <p className="mt-3 text-sm text-wv-red">
            ✗ {denialResult.error}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Ready for Chain</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {pendingChain.length} verified memories awaiting chain submission
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleSubmitBatch()}
            disabled={busy === 'chain' || loading || pendingChain.length === 0}
            className="inline-flex items-center rounded-lg bg-wv-green px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:bg-[rgba(54,211,153,0.85)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {busy === 'chain' ? 'Submitting…' : 'Submit Batch to Chain'}
          </button>
        </div>

        {pendingChain.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories ready for chain submission.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {pendingChain.map(item => (
              <div key={item.submission_hash} className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-wv-panel p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                  <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                    Epoch {item.epoch_id}
                  </span>
				  <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">
					Memory
				  </span>
                  {item.verified_by && (
                    <span className="font-mono text-wv-dim">Verified by {item.verified_by.slice(0, 8)}…</span>
                  )}
                  {item.verified_at && (
                    <ClientTime value={item.verified_at} mode="datetime" />
                  )}
                </div>
                <p className="mt-2 text-sm text-wv-text line-clamp-2">
                  {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                </p>

                {item.extraction_result && item.extraction_result.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-wv-dim">Keywords:</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {item.extraction_result.map((kw, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center rounded-full border border-[rgba(54,211,153,0.28)] bg-[rgba(54,211,153,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-green"
                        >
                          {kw.keyword} {(kw.weight * 100).toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
