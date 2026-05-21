'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  getSubmissionsByStatus,
  submitKeywordResults,
  verifyKeywords,
  rerunKeywords,
  updateKeywords,
  removeSubmission,
  batchChainSubmit,
  getOrgHealth,
  type Submission,
  type KeywordWeight,
  type OrgHealth,
  type VerificationResult,
  type SanitizationFinding,
} from '@/lib/hub-client';
import { getMcpClient, ConnectionState } from '@/lib/mcp-client';

const ORG_ID = process.env.NEXT_PUBLIC_ORG_ID ?? '';

type MemoryKeywordResult = {
  submission_hash: string;
  classified: KeywordWeight[];
};

export default function ChainSubmitPage() {
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

  const clientRef = { current: getMcpClient() };

  const loadAll = useCallback(async () => {
    if (!ORG_ID) return;
    setLoading(true);
    setError(null);
    try {
      const [health, pk, rk, pc] = await Promise.all([
        getOrgHealth(ORG_ID),
        getSubmissionsByStatus(ORG_ID, 'pending_keyword'),
        getSubmissionsByStatus(ORG_ID, 'pending_keyword'),
        getSubmissionsByStatus(ORG_ID, 'pending_chain'),
      ]);
      setOrgHealth(health);
      const reviewable = rk.filter(s => s.extraction_result && s.extraction_result.length > 0);
      setPendingKeyword(pk.filter(s => !s.extraction_result || s.extraction_result.length === 0));
      setReviewKeywords(reviewable);
      setPendingChain(pc);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setClientState(getMcpClient().state);
    getMcpClient().addStateListener(setClientState);
  }, []);

  useEffect(() => {
    if (clientState === 'connected') {
      void loadAll();
    }
  }, [clientState, loadAll]);

  const runKeywordExtraction = useCallback(async () => {
    if (!ORG_ID) return;
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
        await submitKeywordResults(ORG_ID, mapped);
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
  }, [pendingKeyword, reviewKeywords, loadAll]);

  const handleVerifyAll = useCallback(async () => {
    if (!ORG_ID) return;
    if (reviewKeywords.length === 0) return;

    setBusy('verify');
    setError(null);
    setVerifyResults(null);

    try {
      const hashes = reviewKeywords.map(s => s.submission_hash);
      const results = await verifyKeywords(ORG_ID, hashes);
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
  }, [reviewKeywords, loadAll]);

  const handleRerun = useCallback(async (hash: string) => {
    if (!ORG_ID) return;
    const feedback = window.prompt('Provide feedback for rerun:');
    if (!feedback) return;

    setBusy(hash);
    setError(null);

    try {
      await rerunKeywords(ORG_ID, hash, feedback);
      setNotice(`Rerun requested for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll]);

  const handleUpdateKeywords = useCallback(async (hash: string, current: KeywordWeight[]) => {
    if (!ORG_ID) return;
    const input = window.prompt('Enter keywords as JSON array [{"keyword":"term","weight":0.9}]:', JSON.stringify(current));
    if (!input) return;

    try {
      const parsed = JSON.parse(input) as KeywordWeight[];
      await updateKeywords(ORG_ID, hash, parsed);
      setNotice(`Keywords updated for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadAll]);

  const handleRemove = useCallback(async (hash: string) => {
    if (!ORG_ID) return;
    if (!window.confirm(`Remove submission ${hash.slice(0, 12)}…? This cannot be undone.`)) return;

    setBusy(hash);
    setError(null);

    try {
      await removeSubmission(ORG_ID, hash);
      setNotice(`Removed ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll]);

  const handleSubmitBatch = useCallback(async () => {
    if (!ORG_ID) return;
    if (pendingChain.length === 0) return;

    setBusy('chain');
    setError(null);
    setTxResult(null);

    try {
      const hashes = pendingChain.map(s => s.submission_hash);
      const result = await batchChainSubmit(ORG_ID, hashes);
      setTxResult(result);
      setNotice(`Batch submitted. Tx: ${result.tx_hash.slice(0, 16)}… (${result.committed_count} committed)`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [pendingChain, loadAll]);

  if (clientState !== 'connected') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Chain Submit</h1>
          <p className="text-sm text-zinc-500">
            Connect to the dashboard MCP server in Settings to manage the batch pipeline.
          </p>
        </header>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          <p className="font-medium">No MCP session detected ({clientState}).</p>
          <p className="mt-2">
            Open <a href="/settings" className="font-medium text-amber-900 underline-offset-2 hover:underline">Settings</a> and connect to your running `wevibe-mcp --dashboard` server.
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
          <p className="mt-1 text-sm text-zinc-500">
            Keyword extraction → Review → Chain submission
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadAll()}
          disabled={loading}
          className="inline-flex items-center rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {orgHealth && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-zinc-200 bg-white/70 p-4 shadow-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-zinc-500">Pending Keyword</p>
            <p className="text-2xl font-semibold text-zinc-900">{orgHealth.pending_keyword_count}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Pending Chain</p>
            <p className="text-2xl font-semibold text-zinc-900">{orgHealth.pending_chain_count}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Last Extraction</p>
            <p className="text-sm font-medium text-zinc-900">
              {orgHealth.last_keyword_extraction
                ? new Date(orgHealth.last_keyword_extraction).toLocaleString()
                : 'Never'}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Last Chain Submit</p>
            <p className="text-sm font-medium text-zinc-900">
              {orgHealth.last_chain_submission
                ? new Date(orgHealth.last_chain_submission).toLocaleString()
                : 'Never'}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {verifyResults && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <h3 className="font-semibold text-zinc-900">Verification Results</h3>
          <div className="mt-2 space-y-1">
            {verifyResults.map(r => (
              <div key={r.submission_hash} className={`text-sm ${r.passed ? 'text-emerald-700' : 'text-rose-700'}`}>
                {r.passed ? '✓' : '✗'} {r.submission_hash.slice(0, 12)}… — {r.passed ? 'Passed' : r.error}
              </div>
            ))}
          </div>
        </div>
      )}

      {txResult && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="font-semibold text-emerald-900">Batch Submitted</h3>
          <p className="mt-1 text-sm text-emerald-700">
            Tx: <span className="font-mono">{txResult.tx_hash}</span>
          </p>
          <p className="text-sm text-emerald-700">
            Committed: {txResult.committed_count} memories
          </p>
        </div>
      )}

      <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Ready for Keywords</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {pendingKeyword.length} memories approved, awaiting keyword extraction
            </p>
          </div>
          <button
            type="button"
            onClick={() => runKeywordExtraction()}
            disabled={busy === 'extraction' || loading || pendingKeyword.length === 0}
            className="inline-flex items-center rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-amber-300"
          >
            {busy === 'extraction' ? 'Extracting…' : 'Run Keyword Extraction'}
          </button>
        </div>

        {pendingKeyword.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No memories pending keyword extraction.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {pendingKeyword.map(item => (
              <div key={item.submission_hash} className="rounded-lg border border-amber-200 bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs">
                        Epoch {item.epoch_id}
                      </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    item.memory_type === 'correct_implementation'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-rose-100 text-rose-700'
                  }`}>
                    {item.memory_type === 'correct_implementation' ? 'Correct' : 'Negative'}
                  </span>
                  {item.sanitization_findings && item.sanitization_findings.length > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                      {item.sanitization_findings.length} content issue(s)
                    </span>
                  )}
                  {item.preference_confidence !== undefined && item.preference_confidence > 0.8 && (
                    <span className="rounded-full bg-red-200 px-2 py-0.5 text-xs font-medium text-red-800">
                      Likely preference ({(item.preference_confidence * 100).toFixed(0)}%)
                    </span>
                  )}
                  {item.preference_confidence !== undefined && item.preference_confidence > 0.5 && item.preference_confidence <= 0.8 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Possible preference ({(item.preference_confidence * 100).toFixed(0)}%)
                    </span>
                  )}
                      {item.moderation_approved_by && (
                        <span>Approved by {item.moderation_approved_by.slice(0, 8)}…</span>
                      )}
                      {item.moderation_approved_at && (
                        <span>{new Date(item.moderation_approved_at).toLocaleString()}</span>
                      )}
                    </div>
                    <p className="mt-2 text-sm text-zinc-700 line-clamp-2">
                      {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                    </p>
                    {item.extraction_feedback && (
                      <p className="mt-2 text-xs text-amber-700">
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

      <section className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Review Keywords</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {reviewKeywords.length} memories with extracted keywords awaiting review
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleVerifyAll()}
            disabled={busy === 'verify' || loading || reviewKeywords.length === 0}
            className="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {busy === 'verify' ? 'Verifying…' : 'Verify All'}
          </button>
        </div>

        {reviewKeywords.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No keywords to review.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {reviewKeywords.map(item => (
              <div key={item.submission_hash} className="rounded-lg border border-indigo-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs">
                    Epoch {item.epoch_id}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    item.memory_type === 'correct_implementation'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-rose-100 text-rose-700'
                  }`}>
                    {item.memory_type === 'correct_implementation' ? 'Correct' : 'Negative'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-zinc-700 line-clamp-2">
                  {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                </p>

                {item.extraction_result && item.extraction_result.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-zinc-600">Keywords:</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {item.extraction_result.map((kw, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700"
                          title={`Weight: ${(kw.weight * 100).toFixed(0)}%`}
                        >
                          {kw.keyword}
                          <span className="ml-1 text-indigo-400">{(kw.weight * 100).toFixed(0)}%</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {item.extraction_feedback && (
                  <p className="mt-2 text-xs text-amber-600">
                    Feedback: {item.extraction_feedback}
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleRerun(item.submission_hash)}
                    disabled={busy === item.submission_hash}
                    className="rounded px-2 py-1 text-xs text-amber-600 hover:bg-amber-50 disabled:cursor-not-allowed"
                  >
                    Rerun
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUpdateKeywords(item.submission_hash, item.extraction_result ?? [])}
                    disabled={busy === item.submission_hash}
                    className="rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed"
                  >
                    Edit Keywords
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(item.submission_hash)}
                    disabled={busy === item.submission_hash}
                    className="rounded px-2 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Ready for Chain</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {pendingChain.length} verified memories awaiting chain submission
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleSubmitBatch()}
            disabled={busy === 'chain' || loading || pendingChain.length === 0}
            className="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300"
          >
            {busy === 'chain' ? 'Submitting…' : 'Submit Batch to Chain'}
          </button>
        </div>

        {pendingChain.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No memories ready for chain submission.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {pendingChain.map(item => (
              <div key={item.submission_hash} className="rounded-lg border border-emerald-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs">
                    Epoch {item.epoch_id}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    item.memory_type === 'correct_implementation'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-rose-100 text-rose-700'
                  }`}>
                    {item.memory_type === 'correct_implementation' ? 'Correct' : 'Negative'}
                  </span>
                  {item.verified_by && (
                    <span>Verified by {item.verified_by.slice(0, 8)}…</span>
                  )}
                  {item.verified_at && (
                    <span>{new Date(item.verified_at).toLocaleString()}</span>
                  )}
                </div>
                <p className="mt-2 text-sm text-zinc-700 line-clamp-2">
                  {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                </p>

                {item.extraction_result && item.extraction_result.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-zinc-600">Keywords:</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {item.extraction_result.map((kw, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
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
