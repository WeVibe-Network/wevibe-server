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
  type Submission,
  type KeywordWeight,
  type KeywordCandidate,
  type OrgHealth,
  type VerificationResult,
  type VerifyEntry,
} from '@/lib/hub-client';
import {
  normalizeKeywordWeights,
  renormalizeFromBase,
  toExcludedSuggestionPayload,
  displayWeight,
} from '@/lib/keyword-weights';
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

type KeywordProvenance = 'green' | 'blue' | 'yellow';
type CuratedKeyword = KeywordWeight & { keywordLc: string };

const CLASSIFIED_PILL_CLASS = 'inline-flex items-center rounded-full border border-[rgba(54,211,153,0.28)] bg-[rgba(54,211,153,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-green transition-colors transition-opacity duration-200';
const BLUE_PILL_CLASS = 'inline-flex items-center rounded-full border border-[rgba(96,165,250,0.4)] bg-[rgba(96,165,250,0.14)] px-2.5 py-0.5 text-xs font-medium text-[rgba(147,197,253,0.95)] transition-colors transition-opacity duration-200';
const YELLOW_PILL_CLASS = 'inline-flex items-center rounded-full border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.14)] px-2.5 py-0.5 text-xs font-medium text-wv-amber transition-colors transition-opacity duration-200';
const EXCLUDED_PILL_CLASS = 'inline-flex items-center rounded-full border border-[rgba(148,163,184,0.4)] bg-[rgba(148,163,184,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-dim opacity-65 transition-colors transition-opacity duration-200';

function keywordPillClass(provenance: KeywordProvenance, selected: boolean): string {
  if (!selected) {
    return EXCLUDED_PILL_CLASS;
  }
  if (provenance === 'green') {
    return CLASSIFIED_PILL_CLASS;
  }
  if (provenance === 'blue') {
    return BLUE_PILL_CLASS;
  }
  return YELLOW_PILL_CLASS;
}

function normalizeKeywordKey(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function mergeExtractionKeywords(extraction: ExtractionResultPayload): CuratedKeyword[] {
  const merged = new Map<string, CuratedKeyword>();

  const appendKeyword = (kw: KeywordWeight, allowOverwrite: boolean) => {
    const keywordLc = normalizeKeywordKey(kw.keyword);
    if (!keywordLc) {
      return;
    }
    if (!allowOverwrite && merged.has(keywordLc)) {
      return;
    }

    const baseWeight = typeof kw.base_weight === 'number' && Number.isFinite(kw.base_weight)
      ? kw.base_weight
      : kw.weight;

    merged.set(keywordLc, {
      ...kw,
      keywordLc,
      base_weight: baseWeight,
    });
  };

  extraction.classified.forEach((kw) => appendKeyword(kw, true));
  extraction.suggestions.forEach((kw) => appendKeyword(kw, false));

  return Array.from(merged.values()).sort((left, right) => left.keyword.localeCompare(right.keyword));
}

function getPreferenceConfidenceChip(confidence: number): { className: string; title: string } {
  if (confidence > 0.8) {
    return {
      className: 'rounded-full border border-[rgba(255,107,107,0.45)] bg-[rgba(255,107,107,0.16)] px-2 py-0.5 text-xs font-medium text-wv-red',
      title: 'Likely taste',
    };
  }

  if (confidence > 0.5) {
    return {
      className: 'rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber',
      title: 'Possible preference',
    };
  }

  return {
    className: 'rounded-full border border-wv-line bg-wv-panel-2 px-2 py-0.5 text-xs font-medium text-wv-dim',
    title: 'Fact / convention',
  };
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
  const [verifyingHashes, setVerifyingHashes] = useState<Set<string>>(new Set());
  const [verifyingItems, setVerifyingItems] = useState<Submission[]>([]);
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
  const [deselectedKeywords, setDeselectedKeywords] = useState<Record<string, Set<string>>>({});

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

  const keywordProvenance = useCallback((keyword: string): KeywordProvenance => {
    const keywordLc = normalizeKeywordKey(keyword);
    if (!keywordLc) {
      return 'yellow';
    }
    if (orgVocabulary.has(keywordLc)) {
      return 'green';
    }
    if (keywordCandidates.get(keywordLc)?.commonly_suggested === true) {
      return 'blue';
    }
    return 'yellow';
  }, [orgVocabulary, keywordCandidates]);

  const toggleKeyword = useCallback((hash: string, keywordLc: string) => {
    const normalizedKeyword = normalizeKeywordKey(keywordLc);
    if (!normalizedKeyword) {
      return;
    }

    setDeselectedKeywords((prev) => {
      const next = { ...prev };
      const existing = next[hash] ?? new Set<string>();
      const updated = new Set(existing);

      if (updated.has(normalizedKeyword)) {
        updated.delete(normalizedKeyword);
      } else {
        updated.add(normalizedKeyword);
      }

      if (updated.size === 0) {
        delete next[hash];
      } else {
        next[hash] = updated;
      }

      return next;
    });
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

  useEffect(() => {
    if (!orgId || clientState !== 'connected') return;
    const id = setInterval(() => {
      if (busy === null) {
        void loadAll();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [orgId, clientState, busy, loadAll]);

  const handleVerifyAll = useCallback(async () => {
    if (!orgId) return;
    if (reviewKeywords.length === 0) return;

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

    setVerifyingItems(reviewKeywords);
    setVerifyingHashes(new Set(reviewKeywords.map((submission) => submission.submission_hash)));
    setBusy('verify');
    setVerifyResults(null);
    setNotice(null);

    const total = reviewKeywords.length;

    type EmbedResult = {
      id: string;
      vector: number[] | null;
      embedding_model_id: string;
      embedding_schema_version: string;
      error?: string;
    };

    let progressToastId: string | number | undefined;

    try {
      for (const submission of reviewKeywords) {
        const extraction = parseExtractionResult(submission.extraction_result);
        const allKeywords = mergeExtractionKeywords(extraction);
        const deselectedSet = deselectedKeywords[submission.submission_hash];

        const selectedList = allKeywords
          .filter((kw) => !(deselectedSet?.has(kw.keywordLc) ?? false))
          .map(({ keyword, weight, base_weight }) => ({ keyword, weight, base_weight }));

        if (selectedList.length === 0) {
          toast.error(`At least one keyword must stay selected for ${submission.submission_hash.slice(0, 12)}…`);
          return;
        }

        const deselectedItems = allKeywords
          .filter((kw) => deselectedSet?.has(kw.keywordLc) ?? false)
          .map(({ keyword, weight, base_weight }) => ({ keyword, weight, base_weight }));

        await updateKeywords(
          orgId,
          submission.submission_hash,
          renormalizeFromBase(selectedList),
          toExcludedSuggestionPayload(deselectedItems),
        );
      }

      // Progress lives in the toaster (a single sonner toast updated in place across
      // both stages), not on the page.
      progressToastId = toast.loading(`Embedding retrieval cards… 0 / ${total}`);

      // Stage 1 — embed retrieval cards ONE memory at a time so we can report real
      // "X of N" progress. Decrypting + embedding each card through the local LLM
      // provider is the slow step.
      const embedResults: EmbedResult[] = [];
      for (let index = 0; index < reviewKeywords.length; index += 1) {
        const submission = reviewKeywords[index];

        const batch = await client.callTool<EmbedResult[]>('wevibe_embed_retrieval_card', {
          org_id: orgId,
          items: [{
            id: submission.submission_hash,
            ciphertext_hex: submission.ciphertext_hex as string,
            wrapped_dek_mod: submission.wrapped_dek_mod as string,
            stack_hint: submission.stack_hint ?? [],
          }],
        });

        embedResults.push(...batch);
        toast.loading(`Embedding retrieval cards… ${index + 1} / ${total}`, { id: progressToastId });
      }

      const embedById = new Map(embedResults.map((result) => [result.id, result] as const));
      const missingHashes = reviewKeywords.filter(
        (submission) => !embedById.has(submission.submission_hash),
      );
      if (embedResults.length !== reviewKeywords.length || missingHashes.length > 0) {
        if (progressToastId === undefined) {
          toast.error(`Embedding output mismatch for ${missingHashes.length} memory(ies) — verification aborted.`);
        } else {
          toast.error(`Embedding output mismatch for ${missingHashes.length} memory(ies) — verification aborted.`, { id: progressToastId });
        }
        return;
      }

      const failed = embedResults.filter((r) => !r.vector || r.error);
      if (failed.length > 0) {
        if (progressToastId === undefined) {
          toast.error(`Embedding failed for ${failed.length} memory(ies) — ensure Ollama and the LLM provider are reachable. First error: ${failed[0]?.error ?? 'no vector returned'}`);
        } else {
          toast.error(`Embedding failed for ${failed.length} memory(ies) — ensure Ollama and the LLM provider are reachable. First error: ${failed[0]?.error ?? 'no vector returned'}`, { id: progressToastId });
        }
        return;
      }

      const entries: VerifyEntry[] = embedResults.map((r) => ({
        submission_hash: r.id,
        vector: r.vector as number[],
        embedding_model_id: r.embedding_model_id,
        embedding_schema_version: r.embedding_schema_version,
      }));

      // Stage 2 — hub verifies canonical messages + signatures for all entries.
      if (progressToastId === undefined) {
        toast.loading(`Verifying ${total} ${total === 1 ? 'memory' : 'memories'} on the hub…`);
      } else {
        toast.loading(`Verifying ${total} ${total === 1 ? 'memory' : 'memories'} on the hub…`, { id: progressToastId });
      }
      const results = await verifyKeywords(orgId, entries);
      setVerifyResults(results);
      const allPassed = results.every(r => r.passed);
      if (allPassed) {
        if (progressToastId === undefined) {
          toast.success('All keywords verified successfully.');
        } else {
          toast.success('All keywords verified successfully.', { id: progressToastId });
        }
      } else {
        const firstError = results.find((result) => !result.passed && result.error)?.error;
        if (progressToastId === undefined) {
          toast.error(firstError ? `Verification failed: ${firstError}` : 'Some verifications failed. Check results below.');
        } else {
          toast.error(firstError ? `Verification failed: ${firstError}` : 'Some verifications failed. Check results below.', { id: progressToastId });
        }
      }
      await loadAll();
    } catch (err) {
      if (progressToastId === undefined) {
        toast.error((err as Error).message);
      } else {
        toast.error((err as Error).message, { id: progressToastId });
      }
    } finally {
      setBusy(null);
      setVerifyingHashes(new Set());
      setVerifyingItems([]);
    }
  }, [reviewKeywords, deselectedKeywords, loadAll, orgId]);

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

  const awaiting = reviewKeywords.filter((submission) => !verifyingHashes.has(submission.submission_hash));
  const pendingVerification = verifyingItems.filter(
    (submission) => !pendingChain.some((pending) => pending.submission_hash === submission.submission_hash),
  );

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
            <h2 className="text-lg font-semibold text-wv-text">Awaiting verification</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {awaiting.length} memories awaiting verification
            </p>
            <p className="mt-1 text-xs text-wv-amber">
              Green = already in your keyword set · Blue = commonly suggested by contributors · Yellow = new (joins the set on commit) · Click any keyword to deselect (gray = won’t commit).
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleVerifyAll()}
            disabled={busy === 'verify' || loading || awaiting.length === 0}
            className="inline-flex items-center whitespace-nowrap rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {busy === 'verify' ? 'Verifying…' : 'Verify All'}
          </button>
        </div>

        {awaiting.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories awaiting verification.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {awaiting.map((item) => {
              const extraction = parseExtractionResult(item.extraction_result);
              const itemBusy = busy === item.submission_hash || busy === 'verify';
              const recommendation = parseModerationRecommendation(item.mod_votes);
              const moderatorRecommendations = item.moderator_recommendations ?? [];
              const moderatorVotesExpanded = expandedModeratorVotes[item.submission_hash] ?? false;
              const allKeywords = mergeExtractionKeywords(extraction);
              const deselectedSet = deselectedKeywords[item.submission_hash];
              const selectedList = allKeywords
                .filter((kw) => !(deselectedSet?.has(kw.keywordLc) ?? false))
                .map(({ keyword, weight, base_weight }) => ({ keyword, weight, base_weight }));
              const renorm = renormalizeFromBase(selectedList);
              const renormByKeyword = new Map(
                renorm.map((kw) => [normalizeKeywordKey(kw.keyword), kw.weight] as const),
              );
              const preferenceConfidence = typeof item.preference_confidence === 'number' && Number.isFinite(item.preference_confidence)
                ? item.preference_confidence
                : null;
              const preferenceChip = preferenceConfidence === null
                ? null
                : getPreferenceConfidenceChip(preferenceConfidence);

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
                    {preferenceConfidence !== null && preferenceChip && (
                      <span className={preferenceChip.className} title={preferenceChip.title}>
                        Preference {preferenceConfidence.toFixed(2)}
                      </span>
                    )}
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

                  <p className="mt-2 text-sm text-wv-text whitespace-pre-wrap break-words">
                    {item.plaintext ?? 'No plaintext'}
                  </p>

                  <div className="mt-3">
                    <p className="text-xs font-medium text-wv-dim">Keywords</p>
                    <p className="mt-1 text-[11px] text-wv-dim">
                      Green = already in your keyword set · Blue = commonly suggested by contributors · Yellow = new (joins the set on commit) · Click any keyword to deselect (gray = won’t commit).
                    </p>
                    {allKeywords.length === 0 ? (
                      <p className="mt-1 text-xs text-wv-dim">No extracted keywords yet.</p>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {allKeywords.map((kw) => {
                          const selected = !(deselectedSet?.has(kw.keywordLc) ?? false);
                          const provenance = keywordProvenance(kw.keyword);
                          const selectedWeight = renormByKeyword.get(kw.keywordLc);
                          const weightLabel = selectedWeight === undefined
                            ? null
                            : `${(selectedWeight * 100).toFixed(0)}%`;
                          const selectedHoverClass = provenance === 'green'
                            ? 'cursor-pointer hover:border-[rgba(54,211,153,0.45)] hover:bg-[rgba(54,211,153,0.2)]'
                            : provenance === 'blue'
                              ? 'cursor-pointer hover:border-[rgba(96,165,250,0.55)] hover:bg-[rgba(96,165,250,0.22)]'
                              : 'cursor-pointer hover:border-[rgba(255,178,85,0.55)] hover:bg-[rgba(255,178,85,0.22)]';

                          return (
                            <button
                              type="button"
                              key={kw.keyword}
                              onClick={() => toggleKeyword(item.submission_hash, kw.keywordLc)}
                              disabled={itemBusy || loading}
                              className={`${keywordPillClass(provenance, selected)} ${itemBusy || loading
                                ? 'cursor-not-allowed'
                                : selected
                                  ? selectedHoverClass
                                  : 'cursor-pointer hover:border-[rgba(148,163,184,0.6)] hover:bg-[rgba(148,163,184,0.18)] hover:opacity-90'}`}
                              title={selected
                                ? `Selected · Weight ${weightLabel ?? '0%'} · Click to deselect`
                                : 'Deselected · Click to select'}
                            >
                              {kw.keyword}
                              {selected && weightLabel && (
                                <span className="ml-1 text-wv-dim">{weightLabel}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
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

        {pendingChain.length === 0 && pendingVerification.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories ready for chain submission.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {pendingChain.length === 0 ? (
              <p className="text-sm text-wv-dim">No memories ready for chain submission.</p>
            ) : (
              <div className="space-y-3">
                {pendingChain.map((item) => {
                  const extraction = parseExtractionResult(item.extraction_result);
                  const preferenceConfidence = typeof item.preference_confidence === 'number' && Number.isFinite(item.preference_confidence)
                    ? item.preference_confidence
                    : null;
                  const preferenceChip = preferenceConfidence === null
                    ? null
                    : getPreferenceConfidenceChip(preferenceConfidence);

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
                        {preferenceConfidence !== null && preferenceChip && (
                          <span className={preferenceChip.className} title={preferenceChip.title}>
                            Preference {preferenceConfidence.toFixed(2)}
                          </span>
                        )}
                        {item.verified_by && (
                          <span className="font-mono text-wv-dim">Verified by {item.verified_by.slice(0, 8)}…</span>
                        )}
                        {item.verified_at && (
                          <ClientTime value={item.verified_at} mode="datetime" />
                        )}
                      </div>
                      <p className="mt-2 text-sm text-wv-text whitespace-pre-wrap break-words">
                        {item.plaintext ?? 'No plaintext'}
                      </p>

                      {extraction.classified.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs font-medium text-wv-dim">Keywords:</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {extraction.classified.map((kw, idx) => {
                              return (
                                <span
                                  key={`${kw.keyword}-${idx}`}
                                  className={keywordPillClass(keywordProvenance(kw.keyword), true)}
                                >
                                  {kw.keyword} {(displayWeight(kw, true) * 100).toFixed(0)}%
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

            {pendingVerification.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-wv-dim">
                  Pending verification ({pendingVerification.length})
                </h3>
                <div className="space-y-3">
                  {pendingVerification.map((item) => {
                    const extraction = parseExtractionResult(item.extraction_result);
                    const allKeywords = mergeExtractionKeywords(extraction);
                    const deselectedSet = deselectedKeywords[item.submission_hash];
                    const selectedList = allKeywords
                      .filter((kw) => !(deselectedSet?.has(kw.keywordLc) ?? false))
                      .map(({ keyword, weight, base_weight }) => ({ keyword, weight, base_weight }));
                    const renorm = renormalizeFromBase(selectedList);
                    const renormByKeyword = new Map(
                      renorm.map((kw) => [normalizeKeywordKey(kw.keyword), kw.weight] as const),
                    );

                    return (
                      <div
                        key={`pending-verification-${item.submission_hash}`}
                        className="rounded-lg border border-[rgba(255,178,85,0.35)] bg-wv-panel p-4 opacity-70"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                          <span className="font-mono">{item.submission_hash.slice(0, 16)}…</span>
                          <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                            Epoch {item.epoch_id}
                          </span>
                          <span className="rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber">
                            Pending verification
                          </span>
                        </div>

                        <p className="mt-2 text-sm text-wv-text whitespace-pre-wrap break-words">
                          {item.plaintext ?? 'No plaintext'}
                        </p>

                        <div className="mt-3">
                          <p className="text-xs font-medium text-wv-dim">Keywords</p>
                          {allKeywords.length === 0 ? (
                            <p className="mt-1 text-xs text-wv-dim">No extracted keywords yet.</p>
                          ) : (
                            <div className="mt-1 flex flex-wrap gap-2">
                              {allKeywords.map((kw, idx) => {
                                const selected = !(deselectedSet?.has(kw.keywordLc) ?? false);
                                const selectedWeight = renormByKeyword.get(kw.keywordLc);
                                const weightLabel = selectedWeight === undefined
                                  ? null
                                  : `${(selectedWeight * 100).toFixed(0)}%`;

                                return (
                                  <span
                                    key={`${item.submission_hash}-${kw.keyword}-${idx}`}
                                    className={`${keywordPillClass(keywordProvenance(kw.keyword), selected)} cursor-not-allowed opacity-80`}
                                    title={selected
                                      ? `Selected · Weight ${weightLabel ?? '0%'}`
                                      : 'Deselected'}
                                  >
                                    {kw.keyword}
                                    {selected && weightLabel && (
                                      <span className="ml-1 text-wv-dim">{weightLabel}</span>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
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
