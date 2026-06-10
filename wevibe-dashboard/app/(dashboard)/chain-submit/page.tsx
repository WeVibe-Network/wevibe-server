'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  getSubmissionsByStatus,
  listKeywords,
  submitKeywordResults,
  verifyKeywords,
  updateKeywords,
  removeSubmission,
  denySubmission,
  getOrgHealth,
  prepareBatchSubmit,
  addKeyword,
  type Submission,
  type KeywordWeight,
  type OrgHealth,
  type VerificationResult,
  type VerifyEntry,
} from '@/lib/hub-client';
import { getMcpClient, ConnectionState } from '@/lib/mcp-client';
import {
  buildApproveMemoryMsg,
  buildSubmitCommitmentMsg,
  directBroadcast,
  getOrgAccountAddress,
} from '@/lib/chain-client';
import ClientTime from '@/components/ui/client-time';
import { useOrgContext } from '@/lib/org-context';

type MemoryKeywordResult = {
  submission_hash: string;
  classified: KeywordWeight[];
};

type DecryptBatchItem = {
  id: string;
  plaintext: string | null;
  error?: string;
};

type KeywordSuggestion = {
  keyword: string;
  weight: number;
  rationale?: string;
};

type ExtractKeywordsBatchItem = {
  id: string;
  classified: KeywordWeight[];
  suggestions: KeywordSuggestion[];
};

type ExtractionResultPayload = {
  classified: KeywordWeight[];
  suggestions: KeywordWeight[];
};

function normalizeKeywordWeights(input: unknown): KeywordWeight[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => {
      const candidate = entry as { keyword?: unknown; weight?: unknown };
      const keyword = typeof candidate.keyword === 'string' ? candidate.keyword.trim() : '';
      const weight = typeof candidate.weight === 'number' ? candidate.weight : Number(candidate.weight);

      if (!keyword || !Number.isFinite(weight) || weight < 0) {
        return null;
      }

      return { keyword, weight };
    })
    .filter((entry): entry is KeywordWeight => entry !== null);
}

function parseExtractionResult(extractionResult: Submission['extraction_result']): ExtractionResultPayload {
  const raw = extractionResult as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { classified: [], suggestions: [] };
  }

  const payload = raw as { classified?: unknown; suggestions?: unknown };
  return {
    classified: normalizeKeywordWeights(payload.classified),
    suggestions: normalizeKeywordWeights(payload.suggestions),
  };
}

function hasExtractionResult(extractionResult: Submission['extraction_result']): boolean {
  const parsed = parseExtractionResult(extractionResult);
  return parsed.classified.length > 0 || parsed.suggestions.length > 0;
}

function parseModerationRecommendation(
  votes: Submission['mod_votes'],
): { approve: number; flag: number; flagHeavy: boolean } | null {
  if (!votes) {
    return null;
  }

  const approve = Number.isFinite(votes.approve) ? Math.max(0, Math.trunc(votes.approve)) : 0;
  const flag = Number.isFinite(votes.flag) ? Math.max(0, Math.trunc(votes.flag)) : 0;
  if (approve + flag === 0) {
    return null;
  }

  return {
    approve,
    flag,
    flagHeavy: flag > approve,
  };
}

function parseKeywordVoteTally(
  keywordVotes: Submission['keyword_votes'],
  keyword: string,
): { include: number; exclude: number } | null {
  if (!keywordVotes) {
    return null;
  }

  const direct = keywordVotes[keyword];
  const fallback = direct ?? Object.entries(keywordVotes).find(
    ([candidate]) => candidate.toLowerCase() === keyword.toLowerCase(),
  )?.[1];

  if (!fallback) {
    return null;
  }

  return {
    include: Number.isFinite(fallback.include) ? Math.max(0, Math.trunc(fallback.include)) : 0,
    exclude: Number.isFinite(fallback.exclude) ? Math.max(0, Math.trunc(fallback.exclude)) : 0,
  };
}

function renormalizeClassifiedWeights(classified: KeywordWeight[]): KeywordWeight[] {
  const cleaned = normalizeKeywordWeights(classified);
  if (cleaned.length === 0) {
    return [];
  }

  const totalWeight = cleaned.reduce((sum, keyword) => sum + keyword.weight, 0);
  if (totalWeight <= 0) {
    const uniform = 1 / cleaned.length;
    return cleaned.map((keyword, idx) => ({
      keyword: keyword.keyword,
      weight: idx === cleaned.length - 1 ? 1 - uniform * (cleaned.length - 1) : uniform,
    }));
  }

  const normalized = cleaned.map((keyword) => ({
    keyword: keyword.keyword,
    weight: keyword.weight / totalWeight,
  }));

  const normalizedTotal = normalized.reduce((sum, keyword) => sum + keyword.weight, 0);
  const correction = 1 - normalizedTotal;
  const lastIndex = normalized.length - 1;
  normalized[lastIndex] = {
    ...normalized[lastIndex],
    weight: Math.max(0, normalized[lastIndex].weight + correction),
  };

  return normalized;
}

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
  const [orgVocabulary, setOrgVocabulary] = useState<Set<string>>(new Set());

  const resolveOrgAccountForGas = useCallback(async (): Promise<string> => {
    if (!orgId) {
      throw new Error('could not resolve org account for gas');
    }

    try {
      const orgAccount = (await getOrgAccountAddress(orgId)).trim();
      if (!orgAccount) {
        throw new Error('missing org account');
      }
      return orgAccount;
    } catch {
      throw new Error('could not resolve org account for gas');
    }
  }, [orgId]);

  const loadAll = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [health, pendingKeywordRaw, pendingChainRaw, keywords] = await Promise.all([
        getOrgHealth(orgId),
        getSubmissionsByStatus(orgId, 'pending_keyword'),
        getSubmissionsByStatus(orgId, 'pending_chain'),
        listKeywords(orgId),
      ]);

      const vocabulary = new Set(
        keywords
          .map((entry) => entry.keyword.trim().toLowerCase())
          .filter((keyword) => keyword.length > 0),
      );

      const decryptItems = [...pendingKeywordRaw, ...pendingChainRaw]
        .filter((submission): submission is Submission & { ciphertext_hex: string; wrapped_dek_mod: string } => (
          typeof submission.ciphertext_hex === 'string'
          && submission.ciphertext_hex.length > 0
          && typeof submission.wrapped_dek_mod === 'string'
          && submission.wrapped_dek_mod.length > 0
        ))
        .map((submission) => ({
          id: submission.submission_hash,
          ciphertext_hex: submission.ciphertext_hex,
          wrapped_dek_mod: submission.wrapped_dek_mod,
        }));

      const plaintextByHash = new Map<string, string | null>();
      if (decryptItems.length > 0) {
        const decrypted = await getMcpClient().callTool<DecryptBatchItem[]>('wevibe_decrypt_batch', {
          items: decryptItems,
        });
        for (const item of decrypted) {
          plaintextByHash.set(item.id, item.plaintext ?? null);
        }
      }

      const applyPlaintext = (items: Submission[]): Submission[] => (
        items.map((item) => ({
          ...item,
          plaintext: plaintextByHash.has(item.submission_hash)
            ? (plaintextByHash.get(item.submission_hash) ?? null)
            : (item.plaintext ?? null),
        }))
      );

      const keywordQueue = applyPlaintext(pendingKeywordRaw);
      const chainQueue = applyPlaintext(pendingChainRaw);

      setOrgHealth(health);
      setOrgVocabulary(vocabulary);
      const reviewable = keywordQueue.filter((submission) => hasExtractionResult(submission.extraction_result));
      setPendingKeyword(keywordQueue.filter((submission) => !hasExtractionResult(submission.extraction_result)));
      setReviewKeywords(reviewable);
      setPendingChain(chainQueue);
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

  const runKeywordExtractionForSubmission = useCallback(async (submission: Submission) => {
    if (!orgId) return;

    const client = getMcpClient();
    if (client.state !== 'connected') {
      setError('Connect to the MCP server to run keyword extraction.');
      return;
    }

    const plaintext = (submission.plaintext ?? '').trim();
    if (plaintext.length === 0) {
      setError(`No decrypted plaintext available for ${submission.submission_hash.slice(0, 12)}…`);
      return;
    }

    setBusy(submission.submission_hash);
    setError(null);
    setNotice(null);

    try {
      const result = await client.callTool<ExtractKeywordsBatchItem[]>('wevibe_extract_keywords_batch', {
        memories: [{
          id: submission.submission_hash,
          plaintext,
          stack_hint: submission.stack_hint ?? [],
          memory_type: submission.memory_type ?? 'memory',
        }],
      });

      const extracted = result.find((entry) => entry.id === submission.submission_hash);
      if (!extracted) {
        throw new Error('Keyword extraction returned no result for submission.');
      }

      const mapped: MemoryKeywordResult[] = [{
        submission_hash: submission.submission_hash,
        classified: [
          ...normalizeKeywordWeights(extracted.classified),
          ...normalizeKeywordWeights((extracted.suggestions ?? []).map((keyword) => ({
            keyword: keyword.keyword,
            weight: keyword.weight,
          }))),
        ],
      }];

      await submitKeywordResults(orgId, mapped);
      setNotice(`Keyword extraction updated for ${submission.submission_hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleVerifyAll = useCallback(async () => {
    if (!orgId) return;
    if (reviewKeywords.length === 0) return;

    setBusy('verify');
    setError(null);
    setVerifyResults(null);

    try {
      const client = getMcpClient();
      if (client.state !== 'connected') {
        setError('Connect to the MCP server to verify keywords.');
        return;
      }

      const missingPayload = reviewKeywords.find((submission) => (
        typeof submission.ciphertext_hex !== 'string'
        || submission.ciphertext_hex.length === 0
        || typeof submission.wrapped_dek_mod !== 'string'
        || submission.wrapped_dek_mod.length === 0
      ));
      if (missingPayload) {
        setError(`Missing encrypted payload for ${missingPayload.submission_hash.slice(0, 12)}…; cannot verify.`);
        return;
      }

      const items = reviewKeywords.map((s) => ({
        id: s.submission_hash,
        ciphertext_hex: s.ciphertext_hex as string,
        wrapped_dek_mod: s.wrapped_dek_mod as string,
        stack_hint: s.stack_hint ?? [],
      }));

      const embedResults = await client.callTool<Array<{
        id: string;
        vector: number[] | null;
        embedding_model_id: string;
        embedding_schema_version: string;
        error?: string;
      }>>('wevibe_embed_retrieval_card', { org_id: orgId, items });

      const embedById = new Map(embedResults.map((result) => [result.id, result] as const));
      const missingHashes = reviewKeywords.filter(
        (submission) => !embedById.has(submission.submission_hash),
      );
      if (embedResults.length !== reviewKeywords.length || missingHashes.length > 0) {
        setError(`Embedding output mismatch for ${missingHashes.length} memory(ies) — verification aborted.`);
        return;
      }

      const failed = embedResults.filter((r) => !r.vector || r.error);
      if (failed.length > 0) {
        setError(`Embedding failed for ${failed.length} memory(ies) — ensure Ollama and the LLM provider are reachable. First error: ${failed[0]?.error ?? 'no vector returned'}`);
        return;
      }

      const entries: VerifyEntry[] = embedResults.map((r) => ({
        submission_hash: r.id,
        vector: r.vector as number[],
        embedding_model_id: r.embedding_model_id,
        embedding_schema_version: r.embedding_schema_version,
      }));

      const results = await verifyKeywords(orgId, entries);
      setVerifyResults(results);
      const allPassed = results.every(r => r.passed);
      if (allPassed) {
        setNotice('All keywords verified successfully.');
      } else {
        const firstError = results.find((result) => !result.passed && result.error)?.error;
        setError(firstError ? `Verification failed: ${firstError}` : 'Some verifications failed. Check results below.');
      }
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [reviewKeywords, loadAll, orgId]);

  const handleRerun = useCallback(async (submission: Submission) => {
    await runKeywordExtractionForSubmission(submission);
  }, [runKeywordExtractionForSubmission]);

  const handleDeleteClassifiedKeyword = useCallback(async (
    hash: string,
    classified: KeywordWeight[],
    suggestions: KeywordWeight[],
    removeIndex: number,
  ) => {
    if (!orgId) return;

    const nextClassified = renormalizeClassifiedWeights(
      classified.filter((_, idx) => idx !== removeIndex),
    );
    if (nextClassified.length === 0) {
      setError('Cannot remove the last classified keyword. Approve a suggestion first.');
      return;
    }

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      await updateKeywords(orgId, hash, nextClassified, suggestions);
      setNotice(`Removed keyword for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleApproveSuggestion = useCallback(async (
    hash: string,
    classified: KeywordWeight[],
    suggestions: KeywordWeight[],
    approveIndex: number,
  ) => {
    if (!orgId) return;

    const approved = suggestions[approveIndex];
    if (!approved) {
      setError('Suggestion no longer available. Refresh and try again.');
      return;
    }

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      await addKeyword(orgId, approved.keyword);

      const nextClassified = renormalizeClassifiedWeights([
        ...classified,
        { keyword: approved.keyword, weight: approved.weight },
      ]);
      const nextSuggestions = suggestions.filter((_, idx) => idx !== approveIndex);

      await updateKeywords(orgId, hash, nextClassified, nextSuggestions);
      setNotice(`Approved “${approved.keyword}” for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleDismissSuggestion = useCallback(async (
    hash: string,
    classified: KeywordWeight[],
    suggestions: KeywordWeight[],
    dismissIndex: number,
  ) => {
    if (!orgId) return;

    const nextClassified = renormalizeClassifiedWeights(classified);
    if (nextClassified.length === 0) {
      setError('Cannot dismiss suggestions while classified keywords are empty. Approve one first.');
      return;
    }

    const nextSuggestions = suggestions.filter((_, idx) => idx !== dismissIndex);

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      await updateKeywords(orgId, hash, nextClassified, nextSuggestions);
      setNotice(`Dismissed suggestion for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleUpdateKeywords = useCallback(async (
    hash: string,
    currentClassified: KeywordWeight[],
    currentSuggestions: KeywordWeight[],
  ) => {
    if (!orgId) return;

    const input = window.prompt(
      'Enter keywords as JSON array [{"keyword":"term","weight":0.9}]:',
      JSON.stringify(currentClassified),
    );
    if (!input) return;

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      const parsed = JSON.parse(input) as KeywordWeight[];
      const normalized = renormalizeClassifiedWeights(parsed);
      if (normalized.length === 0) {
        throw new Error('Classified keywords cannot be empty.');
      }
      await updateKeywords(orgId, hash, normalized, currentSuggestions);
      setNotice(`Keywords updated for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
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

  const handleDenyFinal = useCallback(async (hash: string) => {
    if (!orgId) return;
    if (!window.confirm(`Deny submission ${hash.slice(0, 12)}…? This is final and cannot be undone.`)) return;

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      await denySubmission(orgId, hash);
      setNotice(`Denied ${hash.slice(0, 12)}…`);
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

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletAddress, msgs, orgAccount);
      const txHash = result.txHash;

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
  }, [orgId, pendingChain, resolveOrgAccountForGas]);

  if (!orgId) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Batch Pipeline</h1>
          <p className="text-sm text-wv-dim">
            Curate keywords → Verify → Chain submission
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
            Curate keywords → Verify → Chain submission
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
        <div>
          <h2 className="text-lg font-semibold text-wv-text">Ready for Keywords</h2>
          <p className="mt-1 text-sm text-wv-dim">
            {pendingKeyword.length} memories need keyword (re-)extraction
          </p>
        </div>

        {pendingKeyword.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories currently need keyword extraction.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {pendingKeyword.map((item) => {
              const itemBusy = busy === item.submission_hash;
              const recommendation = parseModerationRecommendation(item.mod_votes);

              return (
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
                        {recommendation && (
                          <span
                            className={recommendation.flagHeavy
                              ? 'rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber'
                              : 'rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.12)] px-2 py-0.5 text-xs font-medium text-wv-violet'}
                          >
                            Moderators: {recommendation.approve} approve · {recommendation.flag} flag
                          </span>
                        )}
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
                        {item.derivation === 'edited-after-extraction' && (
                          <span className="rounded-full bg-[rgba(255,178,85,0.12)] px-2 py-0.5 text-xs font-medium text-wv-amber">
                            edited after extraction
                          </span>
                        )}
                        {item.derivation === 'verbatim' && (
                          <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                            verbatim extraction
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

                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => handleRerun(item)}
                        disabled={itemBusy || loading}
                        className="rounded-lg border border-wv-amber px-3 py-1.5 text-xs font-medium text-wv-amber transition hover:bg-[rgba(255,178,85,0.12)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
                      >
                        {itemBusy ? 'Extracting…' : 'Re-run Extraction'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDenyFinal(item.submission_hash)}
                        disabled={itemBusy || loading}
                        className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-1.5 text-xs font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
                      >
                        Deny (final)
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.12)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Curate Keywords</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {reviewKeywords.length} memories with attached keywords awaiting curation
            </p>
            <p className="mt-1 text-xs text-wv-amber">
              <span className="text-wv-green">Green</span> = classified vocabulary terms · <span className="text-wv-red">Red</span> = new suggestions. Approve or dismiss red suggestions before Verify All.
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
          <p className="mt-4 text-sm text-wv-dim">No memories awaiting keyword curation.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {reviewKeywords.map((item) => {
              const extraction = parseExtractionResult(item.extraction_result);
              const itemBusy = busy === item.submission_hash;
              const recommendation = parseModerationRecommendation(item.mod_votes);

              return (
                <div key={item.submission_hash} className="rounded-lg border border-[rgba(124,92,255,0.4)] bg-wv-panel p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                    <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                    <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                      Epoch {item.epoch_id}
                    </span>
                    <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">
                      Memory
                    </span>
                    {recommendation && (
                      <span
                        className={recommendation.flagHeavy
                          ? 'rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber'
                          : 'rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.12)] px-2 py-0.5 text-xs font-medium text-wv-violet'}
                      >
                        Moderators: {recommendation.approve} approve · {recommendation.flag} flag
                      </span>
                    )}
                  </div>

                  <p className="mt-2 text-sm text-wv-text line-clamp-2">
                    {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                  </p>

                  <div className="mt-3 space-y-3">
                    <div>
                      <p className="text-xs font-medium text-wv-dim">Classified</p>
                      {extraction.classified.length === 0 ? (
                        <p className="mt-1 text-xs text-wv-dim">No classified keywords yet.</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {extraction.classified.map((kw, idx) => (
                            <span
                              key={`${kw.keyword}-${idx}`}
                              className="inline-flex items-center rounded-full border border-[rgba(54,211,153,0.28)] bg-[rgba(54,211,153,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-green"
                              title={`In org vocabulary · Weight: ${(kw.weight * 100).toFixed(0)}%`}
                            >
                              {kw.keyword}
                              <span className="ml-1 text-wv-dim">{(kw.weight * 100).toFixed(0)}%</span>
                              <button
                                type="button"
                                onClick={() => handleDeleteClassifiedKeyword(item.submission_hash, extraction.classified, extraction.suggestions, idx)}
                                disabled={itemBusy || loading}
                                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-wv-green transition hover:bg-[rgba(54,211,153,0.24)] disabled:cursor-not-allowed disabled:text-wv-dim"
                                title="Remove keyword"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <p className="text-xs font-medium text-wv-dim">Suggestions</p>
                      {extraction.suggestions.length === 0 ? (
                        <p className="mt-1 text-xs text-wv-dim">No new keyword suggestions.</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {extraction.suggestions.map((kw, idx) => {
                            const tally = parseKeywordVoteTally(item.keyword_votes, kw.keyword);

                            return (
                              <span
                                key={`${kw.keyword}-${idx}`}
                                className="inline-flex items-center rounded-full border border-[rgba(255,107,107,0.28)] bg-[rgba(255,107,107,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-red"
                                title={`New keyword suggestion · Weight: ${(kw.weight * 100).toFixed(0)}%`}
                              >
                                {kw.keyword}
                                <span className="ml-1 text-wv-dim">{(kw.weight * 100).toFixed(0)}%</span>
                                {tally && (
                                  <span className="ml-2 text-[10px] font-normal text-wv-dim">
                                    include {tally.include} / exclude {tally.exclude}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleApproveSuggestion(item.submission_hash, extraction.classified, extraction.suggestions, idx)}
                                  disabled={itemBusy || loading}
                                  className="ml-2 rounded bg-[rgba(255,255,255,0.2)] px-1.5 py-0.5 text-[10px] font-semibold text-wv-text transition hover:bg-[rgba(255,255,255,0.3)] disabled:cursor-not-allowed disabled:text-wv-dim"
                                >
                                  +vocab
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDismissSuggestion(item.submission_hash, extraction.classified, extraction.suggestions, idx)}
                                  disabled={itemBusy || loading}
                                  className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-wv-red transition hover:bg-[rgba(255,107,107,0.24)] disabled:cursor-not-allowed disabled:text-wv-dim"
                                  title="Dismiss suggestion"
                                >
                                  ×
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  {item.extraction_feedback && (
                    <p className="mt-2 text-xs text-wv-amber">
                      Feedback: {item.extraction_feedback}
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleRerun(item)}
                      disabled={itemBusy || loading}
                      className="rounded px-2 py-1 text-xs text-wv-amber hover:bg-[rgba(255,178,85,0.12)] disabled:cursor-not-allowed"
                    >
                      Re-run Extraction
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUpdateKeywords(item.submission_hash, extraction.classified, extraction.suggestions)}
                      disabled={itemBusy || loading}
                      className="rounded px-2 py-1 text-xs text-wv-violet hover:bg-[rgba(124,92,255,0.12)] disabled:cursor-not-allowed"
                    >
                      Edit Keywords
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(item.submission_hash)}
                      disabled={itemBusy || loading}
                      className="rounded px-2 py-1 text-xs text-wv-red hover:bg-[rgba(255,107,107,0.12)] disabled:cursor-not-allowed"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDenyFinal(item.submission_hash)}
                      disabled={itemBusy || loading}
                      className="rounded px-2 py-1 text-xs text-wv-red hover:bg-[rgba(255,107,107,0.12)] disabled:cursor-not-allowed"
                    >
                      Deny (final)
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
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
            {pendingChain.map((item) => {
              const extraction = parseExtractionResult(item.extraction_result);

              return (
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

                  {extraction.classified.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-wv-dim">Keywords:</p>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {extraction.classified.map((kw, idx) => {
                          const inVocabulary = orgVocabulary.has(kw.keyword.toLowerCase());
                          return (
                            <span
                              key={`${kw.keyword}-${idx}`}
                              className={inVocabulary
                                ? 'inline-flex items-center rounded-full border border-[rgba(54,211,153,0.28)] bg-[rgba(54,211,153,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-green'
                                : 'inline-flex items-center rounded-full border border-[rgba(255,107,107,0.28)] bg-[rgba(255,107,107,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-red'}
                            >
                              {kw.keyword} {(kw.weight * 100).toFixed(0)}%
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
