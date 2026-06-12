'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  getSubmissionsByStatus,
  listKeywords,
  getKeywordCandidates,
  verifyKeywords,
  updateKeywords,
  denySubmission,
  getOrgHealth,
  prepareBatchSubmit,
  addKeyword,
  type Submission,
  type KeywordWeight,
  type KeywordSuggestionPayload,
  type KeywordCandidate,
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
import Modal from '@/components/ui/modal';
import { useOrgContext } from '@/lib/org-context';
import { txConfirming, txError, txSuccess, txToast } from '@/lib/toast';
import { toast } from 'sonner';

type DecryptBatchItem = {
  id: string;
  plaintext: string | null;
  error?: string;
};

type KeywordPillVariant = 'classified' | 'excluded';

const CLASSIFIED_PILL_CLASS = 'inline-flex items-center rounded-full border border-[rgba(54,211,153,0.28)] bg-[rgba(54,211,153,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-green transition-colors transition-opacity duration-200';
const EXCLUDED_PILL_CLASS = 'inline-flex items-center rounded-full border border-[rgba(148,163,184,0.4)] bg-[rgba(148,163,184,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-dim opacity-65 transition-colors transition-opacity duration-200';

function getKeywordPillClass(variant: KeywordPillVariant): string {
  if (variant === 'classified') {
    return CLASSIFIED_PILL_CLASS;
  }
  return EXCLUDED_PILL_CLASS;
}

function shortenPubkey(pubkey: string, visibleChars = 12): string {
  if (pubkey.length <= visibleChars) {
    return pubkey;
  }
  return `${pubkey.slice(0, visibleChars)}…`;
}

type LoadSource = 'orgHealth' | 'pendingKeyword' | 'pendingChain' | 'keywords' | 'decryptBatch';

type LoadDiagnostic = {
  source: LoadSource;
  label: string;
  message: string;
  likelyCause: 'hub unreachable' | 'decrypt backend unavailable' | 'Ollama down' | 'endpoint returned an error';
};

type ExtractionResultPayload = {
  classified: KeywordWeight[];
  suggestions: KeywordWeight[];
};

const LOAD_SOURCE_LABELS: Record<LoadSource, string> = {
  orgHealth: 'Org health',
  pendingKeyword: 'Pending keyword queue',
  pendingChain: 'Pending chain queue',
  keywords: 'Org vocabulary',
  decryptBatch: 'Decrypt batch',
};

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Unknown error';
}

function inferLikelyCause(
  source: LoadSource,
  message: string,
): LoadDiagnostic['likelyCause'] {
  const lower = message.toLowerCase();
  const networkIssue = lower.includes('failed to fetch')
    || lower.includes('network')
    || lower.includes('econnrefused')
    || lower.includes('sse connection failed')
    || lower.includes('timed out')
    || lower.includes('not connected');

  if (lower.includes('ollama')) {
    return 'Ollama down';
  }

  if (source === 'decryptBatch') {
    if (networkIssue) {
      return 'decrypt backend unavailable';
    }
    return 'endpoint returned an error';
  }

  if (networkIssue) {
    return 'hub unreachable';
  }

  return 'endpoint returned an error';
}

function createLoadDiagnostic(source: LoadSource, error: unknown): LoadDiagnostic {
  const message = normalizeErrorMessage(error);
  return {
    source,
    label: LOAD_SOURCE_LABELS[source],
    message,
    likelyCause: inferLikelyCause(source, message),
  };
}

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

function parseModerationRecommendation(
  votes: Submission['mod_votes'],
): { approve: number; flag: number; flagHeavy: boolean } {
  const approveValue = votes?.approve;
  const flagValue = votes?.flag;
  const approve = typeof approveValue === 'number' && Number.isFinite(approveValue)
    ? Math.max(0, Math.trunc(approveValue))
    : 0;
  const flag = typeof flagValue === 'number' && Number.isFinite(flagValue)
    ? Math.max(0, Math.trunc(flagValue))
    : 0;

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

function toExcludedSuggestionPayload(suggestions: KeywordWeight[]): KeywordSuggestionPayload[] {
  return normalizeKeywordWeights(suggestions).map((suggestion) => ({
    keyword: suggestion.keyword,
    weight: suggestion.weight,
    rationale: 'excluded',
  }));
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
  const [reviewKeywords, setReviewKeywords] = useState<Submission[]>([]);
  const [pendingChain, setPendingChain] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadDiagnostics, setLoadDiagnostics] = useState<LoadDiagnostic[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [verifyResults, setVerifyResults] = useState<VerificationResult[] | null>(null);
  const [txResult, setTxResult] = useState<{ tx_hash: string; committed_count: number } | null>(null);
  const [orgVocabulary, setOrgVocabulary] = useState<Set<string>>(new Set());
  const [keywordCandidates, setKeywordCandidates] = useState<Map<string, KeywordCandidate>>(new Map());
  const [expandedModeratorVotes, setExpandedModeratorVotes] = useState<Record<string, boolean>>({});
  const [denyModalSubmissionHash, setDenyModalSubmissionHash] = useState<string | null>(null);

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

  const toggleModeratorVotes = useCallback((submissionHash: string) => {
    setExpandedModeratorVotes((prev) => ({
      ...prev,
      [submissionHash]: !(prev[submissionHash] ?? false),
    }));
  }, []);

  const loadAll = useCallback(async () => {
    if (!orgId) return;

    setLoading(true);
    setLoadDiagnostics([]);

    try {
      const diagnostics: LoadDiagnostic[] = [];
      const [healthResult, pendingKeywordResult, pendingChainResult, keywordsResult, keywordCandidatesResult] = await Promise.allSettled([
        getOrgHealth(orgId),
        getSubmissionsByStatus(orgId, 'pending_keyword'),
        getSubmissionsByStatus(orgId, 'pending_chain'),
        listKeywords(orgId),
        getKeywordCandidates(orgId),
      ]);

      const health = healthResult.status === 'fulfilled'
        ? healthResult.value
        : null;
      if (healthResult.status !== 'fulfilled') {
        diagnostics.push(createLoadDiagnostic('orgHealth', healthResult.reason));
      }

      const pendingKeywordRaw = pendingKeywordResult.status === 'fulfilled'
        ? pendingKeywordResult.value
        : [];
      if (pendingKeywordResult.status !== 'fulfilled') {
        diagnostics.push(createLoadDiagnostic('pendingKeyword', pendingKeywordResult.reason));
      }

      const pendingChainRaw = pendingChainResult.status === 'fulfilled'
        ? pendingChainResult.value
        : [];
      if (pendingChainResult.status !== 'fulfilled') {
        diagnostics.push(createLoadDiagnostic('pendingChain', pendingChainResult.reason));
      }

      const keywords = keywordsResult.status === 'fulfilled'
        ? keywordsResult.value
        : [];
      if (keywordsResult.status !== 'fulfilled') {
        diagnostics.push(createLoadDiagnostic('keywords', keywordsResult.reason));
      }

      const candidates = keywordCandidatesResult.status === 'fulfilled'
        ? keywordCandidatesResult.value
        : [];

      const candidateMap = new Map<string, KeywordCandidate>();
      for (const candidate of candidates) {
        const normalizedKeyword = candidate.keyword.trim().toLowerCase();
        if (normalizedKeyword.length > 0) {
          candidateMap.set(normalizedKeyword, candidate);
        }
      }

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
        try {
          const decrypted = await getMcpClient().callTool<DecryptBatchItem[]>('wevibe_decrypt_batch', {
            items: decryptItems,
          });
          for (const item of decrypted) {
            plaintextByHash.set(item.id, item.plaintext ?? null);
          }
        } catch (decryptError) {
          diagnostics.push(createLoadDiagnostic('decryptBatch', decryptError));
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
      setKeywordCandidates(candidateMap);
      setReviewKeywords(keywordQueue);
      setPendingChain(chainQueue);
      setLoadDiagnostics(diagnostics);
    } catch (err) {
      toast.error((err as Error).message);
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

  const handleVerifyAll = useCallback(async () => {
    if (!orgId) return;
    if (reviewKeywords.length === 0) return;

    setBusy('verify');
    setVerifyResults(null);

    try {
      const client = getMcpClient();
      if (client.state !== 'connected') {
        toast.error('Connect to the MCP server to verify keywords.');
        return;
      }

      const missingPayload = reviewKeywords.find((submission) => (
        typeof submission.ciphertext_hex !== 'string'
        || submission.ciphertext_hex.length === 0
        || typeof submission.wrapped_dek_mod !== 'string'
        || submission.wrapped_dek_mod.length === 0
      ));
      if (missingPayload) {
        toast.error(`Missing encrypted payload for ${missingPayload.submission_hash.slice(0, 12)}…; cannot verify.`);
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
        toast.error(`Embedding output mismatch for ${missingHashes.length} memory(ies) — verification aborted.`);
        return;
      }

      const failed = embedResults.filter((r) => !r.vector || r.error);
      if (failed.length > 0) {
        toast.error(`Embedding failed for ${failed.length} memory(ies) — ensure Ollama and the LLM provider are reachable. First error: ${failed[0]?.error ?? 'no vector returned'}`);
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
        toast.error(firstError ? `Verification failed: ${firstError}` : 'Some verifications failed. Check results below.');
      }
      await loadAll();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [reviewKeywords, loadAll, orgId]);

  const handleExcludeClassifiedKeyword = useCallback(async (
    hash: string,
    classified: KeywordWeight[],
    suggestions: KeywordWeight[],
    excludeIndex: number,
  ) => {
    if (!orgId) return;

    const excluded = classified[excludeIndex];
    if (!excluded) {
      toast.error('Included keyword no longer available. Refresh and try again.');
      return;
    }

    const remainingClassified = classified.filter((_, idx) => idx !== excludeIndex);
    const nextClassified = renormalizeClassifiedWeights(remainingClassified);
    if (nextClassified.length === 0) {
      toast.error('Cannot remove the last included keyword.');
      return;
    }

    const nextSuggestionsWithRationale = toExcludedSuggestionPayload([
      ...suggestions,
      { keyword: excluded.keyword, weight: excluded.weight },
    ]);

    setBusy(hash);
    setNotice(null);

    try {
      await updateKeywords(orgId, hash, nextClassified, nextSuggestionsWithRationale);
      setNotice(`Excluded “${excluded.keyword}” for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleIncludeSuggestionKeyword = useCallback(async (
    hash: string,
    classified: KeywordWeight[],
    suggestions: KeywordWeight[],
    includeIndex: number,
  ) => {
    if (!orgId) return;

    const included = suggestions[includeIndex];
    if (!included) {
      toast.error('Suggestion no longer available. Refresh and try again.');
      return;
    }

    setBusy(hash);
    setNotice(null);

    try {
      try {
        await addKeyword(orgId, included.keyword);
      } catch (addKeywordError) {
        const addKeywordMessage = normalizeErrorMessage(addKeywordError).toLowerCase();
        if (!addKeywordMessage.includes('already exists')) {
          throw addKeywordError;
        }
      }

      const nextClassified = renormalizeClassifiedWeights([
        ...classified,
        { keyword: included.keyword, weight: included.weight },
      ]);
      if (nextClassified.length === 0) {
        toast.error('Failed to include keyword. Refresh and try again.');
        return;
      }

      const nextSuggestionsWithRationale = toExcludedSuggestionPayload(
        suggestions.filter((_, idx) => idx !== includeIndex),
      );

      await updateKeywords(orgId, hash, nextClassified, nextSuggestionsWithRationale);
      setNotice(`Included “${included.keyword}” for ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const handleDenyFinal = useCallback(async (hash: string) => {
    if (!orgId) return;

    setBusy(hash);
    setNotice(null);

    try {
      await denySubmission(orgId, hash);
      setNotice(`Denied ${hash.slice(0, 12)}…`);
      await loadAll();
    } catch (err) {
      toast.error((err as Error).message);
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
      toast.error('No wallet connected');
      return;
    }

    setBusy('chain');
    setTxResult(null);
    setNotice(null);

    let txToastId: string | number | null = null;

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

      txToastId = txToast('Submit serve batch');
      txConfirming(txToastId, 'Submit serve batch');

      const orgAccount = await resolveOrgAccountForGas();
      const result = await directBroadcast(walletAddress, msgs, orgAccount);
      const txHash = result.txHash;

      if (!txHash) {
        throw new Error('Chain submission failed: missing transaction hash');
      }

      setTxResult({ tx_hash: txHash, committed_count: prepared.batch.length });
      setNotice(null);
      // The tx is committed on-chain (DeliverTx code 0), but the hub watcher
      // flips submission status -> committed asynchronously. Drop the
      // just-submitted memories from the pending lists immediately for
      // instant feedback, then reconcile with the hub once the watcher has
      // had time to catch up.
      const submittedHashes = new Set(
        prepared.batch.map((entry) => entry.submission_hash.toLowerCase()),
      );
      const dropSubmitted = (items: Submission[]) =>
        items.filter((item) => !submittedHashes.has(item.submission_hash.toLowerCase()));
      setPendingChain(dropSubmitted);
      setReviewKeywords(dropSubmitted);
      setTimeout(() => { void loadAll(); }, 2500);
      txSuccess(txToastId, 'Serve batch submitted to chain.', txHash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (txToastId !== null) {
        txError(txToastId, message);
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(null);
    }
  }, [orgId, pendingChain, resolveOrgAccountForGas, loadAll]);

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

      {loadDiagnostics.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-medium">Some pipeline data could not load.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {loadDiagnostics.map((diag) => (
                  <li key={diag.source}>
                    <span className="font-medium">{diag.label}</span>: {diag.message}. Likely cause: {diag.likelyCause}.
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={() => loadAll()}
              disabled={loading}
              className="inline-flex items-center rounded-lg border border-[rgba(255,107,107,0.45)] px-3 py-1.5 text-xs font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
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

      <section className="rounded-xl border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.12)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Curate Keywords</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {reviewKeywords.length} memories awaiting curation
            </p>
            <p className="mt-1 text-xs text-wv-amber">
              <span className="text-wv-green">Green</span> = included · <span className="text-wv-dim">Gray</span> = excluded candidate. Click a keyword to include it (adds to vocabulary), click × on an included keyword to undo. Only included keywords are attached and submitted.
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
              const moderatorRecommendations = item.moderator_recommendations ?? [];
              const moderatorVotesExpanded = expandedModeratorVotes[item.submission_hash] ?? false;

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
                    <button
                      type="button"
                      onClick={() => toggleModeratorVotes(item.submission_hash)}
                      aria-expanded={moderatorVotesExpanded}
                      className={recommendation.flagHeavy
                        ? 'inline-flex items-center gap-1 rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber transition hover:bg-[rgba(255,178,85,0.22)]'
                        : 'inline-flex items-center gap-1 rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.12)] px-2 py-0.5 text-xs font-medium text-wv-violet transition hover:bg-[rgba(124,92,255,0.2)]'}
                    >
                      <span>
                        Moderators: {recommendation.approve} approve · {recommendation.flag} flag
                      </span>
                      <span aria-hidden="true" className="text-[10px]">
                        {moderatorVotesExpanded ? '▾' : '▸'}
                      </span>
                    </button>
                  </div>

                  {moderatorVotesExpanded && (
                    <div className="mt-2 rounded-lg border border-wv-line bg-wv-panel-2 p-3">
                      {moderatorRecommendations.length === 0 ? (
                        <p className="text-xs text-wv-dim">No moderator votes yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {moderatorRecommendations.map((moderatorVote, moderatorIndex) => {
                            const keywordVotes = moderatorVote.keyword_votes ?? [];
                            return (
                              <div
                                key={`${moderatorVote.moderator_pubkey}-${moderatorIndex}`}
                                className="rounded-lg border border-wv-line bg-wv-panel px-3 py-2"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-xs text-wv-text" title={moderatorVote.moderator_pubkey}>
                                    {shortenPubkey(moderatorVote.moderator_pubkey)}
                                  </span>
                                  <span className="text-[10px] uppercase tracking-[0.08em] text-wv-dim">submission</span>
                                  <span
                                    className={moderatorVote.submission_vote === 'approve'
                                      ? 'rounded-full border border-[rgba(54,211,153,0.35)] bg-[rgba(54,211,153,0.14)] px-2 py-0.5 text-[10px] font-medium text-wv-green'
                                      : moderatorVote.submission_vote === 'flag'
                                        ? 'rounded-full border border-[rgba(255,107,107,0.35)] bg-[rgba(255,107,107,0.14)] px-2 py-0.5 text-[10px] font-medium text-wv-red'
                                        : 'rounded-full border border-wv-line bg-wv-panel-2 px-2 py-0.5 text-[10px] font-medium text-wv-dim'}
                                  >
                                    {moderatorVote.submission_vote ?? '—'}
                                  </span>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {keywordVotes.length === 0 ? (
                                    <span className="text-xs text-wv-dim">No keyword votes.</span>
                                  ) : (
                                    keywordVotes.map((voteEntry, voteIndex) => (
                                      <span
                                        key={`${voteEntry.keyword}-${voteEntry.vote}-${voteIndex}`}
                                        className={voteEntry.vote === 'include'
                                          ? 'rounded-full border border-[rgba(54,211,153,0.35)] bg-[rgba(54,211,153,0.14)] px-2 py-0.5 text-[10px] font-medium text-wv-green'
                                          : 'rounded-full border border-[rgba(255,107,107,0.35)] bg-[rgba(255,107,107,0.14)] px-2 py-0.5 text-[10px] font-medium text-wv-red'}
                                      >
                                        {voteEntry.keyword} · {voteEntry.vote}
                                      </span>
                                    ))
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <p className="mt-2 text-sm text-wv-text line-clamp-2">
                    {item.plaintext?.slice(0, 200) ?? 'No plaintext'}{item.plaintext && item.plaintext.length > 200 ? '…' : ''}
                  </p>

                  <div className="mt-3 space-y-3">
                    <div>
                      <p className="text-xs font-medium text-wv-dim">Included</p>
                      {extraction.classified.length === 0 ? (
                        <p className="mt-1 text-xs text-wv-dim">No included keywords yet.</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {extraction.classified.map((kw, idx) => {
                            return (
                              <span
                                key={`${kw.keyword}-${idx}`}
                                className={getKeywordPillClass('classified')}
                                title={`Included keyword · Weight: ${(kw.weight * 100).toFixed(0)}%`}
                              >
                                {kw.keyword}
                                <span className="ml-1 text-wv-dim">{(kw.weight * 100).toFixed(0)}%</span>
                                <button
                                  type="button"
                                  onClick={() => handleExcludeClassifiedKeyword(item.submission_hash, extraction.classified, extraction.suggestions, idx)}
                                  disabled={itemBusy || loading}
                                  className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-wv-green transition hover:bg-[rgba(54,211,153,0.24)] disabled:cursor-not-allowed disabled:text-wv-dim"
                                  title="Exclude keyword"
                                >
                                  ×
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div>
                      <p className="text-xs font-medium text-wv-dim">Excluded candidates</p>
                      {extraction.suggestions.length === 0 ? (
                        <p className="mt-1 text-xs text-wv-dim">No excluded keyword candidates.</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {extraction.suggestions.map((kw, idx) => {
                            const tally = parseKeywordVoteTally(item.keyword_votes, kw.keyword);
                            const keywordCandidate = keywordCandidates.get(kw.keyword.trim().toLowerCase());
                            const earned = keywordCandidate?.earned === true;

                            return (
                              <button
                                type="button"
                                key={`${kw.keyword}-${idx}`}
                                onClick={() => handleIncludeSuggestionKeyword(item.submission_hash, extraction.classified, extraction.suggestions, idx)}
                                disabled={itemBusy || loading}
                                className={`${getKeywordPillClass('excluded')} ${itemBusy || loading
                                  ? 'cursor-not-allowed'
                                  : 'cursor-pointer hover:border-[rgba(148,163,184,0.6)] hover:bg-[rgba(148,163,184,0.18)] hover:opacity-90'}`}
                                title={earned
                                  ? `Excluded earned suggestion (${keywordCandidate?.distinct_contributors ?? 0} contributors) · Weight: ${(kw.weight * 100).toFixed(0)}% · Click to include`
                                  : `Excluded keyword suggestion · Weight: ${(kw.weight * 100).toFixed(0)}% · Click to include`}
                              >
                                {kw.keyword}
                                <span className="ml-1 text-wv-dim">{(kw.weight * 100).toFixed(0)}%</span>
                                {earned && keywordCandidate && (
                                  <span className="ml-2 text-[10px] font-semibold text-[rgba(147,197,253,0.95)]">
                                    earned · {keywordCandidate.distinct_contributors} contributors
                                  </span>
                                )}
                                {tally && (
                                  <span className="ml-2 text-[10px] font-normal text-wv-dim">
                                    include {tally.include} / exclude {tally.exclude}
                                  </span>
                                )}
                              </button>
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

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setDenyModalSubmissionHash(item.submission_hash)}
                      disabled={itemBusy || loading}
                      className="rounded border border-[rgba(255,107,107,0.5)] bg-[rgba(255,107,107,0.1)] px-2 py-1 text-xs font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.2)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
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

      <Modal
        open={denyModalSubmissionHash !== null}
        title="Deny submission?"
        onClose={() => setDenyModalSubmissionHash(null)}
        footer={(
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDenyModalSubmissionHash(null)}
              className="rounded-lg border border-wv-line px-3 py-1.5 text-sm font-medium text-wv-dim transition hover:text-wv-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (!denyModalSubmissionHash) {
                  return;
                }
                const hashToDeny = denyModalSubmissionHash;
                setDenyModalSubmissionHash(null);
                void handleDenyFinal(hashToDeny);
              }}
              className="rounded-lg border border-[rgba(255,107,107,0.5)] bg-[rgba(255,107,107,0.1)] px-3 py-1.5 text-sm font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.2)]"
            >
              Deny
            </button>
          </div>
        )}
      >
        Are you sure? This action cannot be undone.
      </Modal>
    </div>
  );
}
