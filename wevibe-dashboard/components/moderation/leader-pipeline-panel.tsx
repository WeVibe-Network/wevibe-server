'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  denyPendingForContributor,
  getCommitStatus,
  getSubmissionsByStatus,
  listMembers,
  listKeywords,
  getKeywordCandidates,
  denySubmission,
  prepareBatchSubmit,
  getDuplicateClusters,
  type Submission,
  type KeywordWeight,
  type KeywordCandidate,
  type DuplicateClustersResponse,
} from '@/lib/hub-client';
import { remediationFor } from '@/lib/error-remediation';
import { isHubError } from '@/lib/hub-error';
import {
  normalizeKeywordWeights,
  renormalizeFromBase,
  toExcludedSuggestionPayload,
  displayWeight,
} from '@/lib/keyword-weights';
import { requestProvisionRecall } from '@/lib/org-bridge';
import { getMcpClient, ConnectionState } from '@/lib/mcp-client';
import {
  buildApproveMemoryMsg,
  buildSetMemberCapabilitiesMsg,
  buildSubmitCommitmentMsg,
  directBroadcast,
  getOrgAccountAddress,
} from '@/lib/chain-client';
import {
  type VerificationJobInput,
  enqueueVerificationBatch,
  reconcileSettledHashes,
  removeVerification,
  resumeVerifyQueue,
  retryVerification,
  useVerifyQueue,
} from '@/lib/verify-queue';
import ClientTime from '@/components/ui/client-time';
import Modal from '@/components/ui/modal';
import { PreferenceScoreCard } from '@/components/memory/preference-score-card';
import { DashboardServerControls } from '@/components/backend/dashboard-server-controls';
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

function shortenPubkey(pubkey: string, visibleChars = 12): string {
  if (pubkey.length <= visibleChars) {
    return pubkey;
  }
  return `${pubkey.slice(0, visibleChars)}…`;
}

function shortenHash(hash: string | null | undefined, visibleChars = 12): string {
  const normalized = hash?.trim() ?? '';
  if (!normalized) {
    return 'unknown';
  }
  if (normalized.length <= visibleChars) {
    return normalized;
  }
  return `${normalized.slice(0, visibleChars)}…`;
}

function formatSimilarityPercent(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  return `${(clamped * 100).toFixed(1)}%`;
}

type LoadSource = 'pendingKeyword' | 'pendingChain' | 'keywords' | 'decryptBatch' | 'duplicateClusters' | 'commitStatus';

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
  pendingKeyword: 'Pending keyword queue',
  pendingChain: 'Pending chain queue',
  keywords: 'Org vocabulary',
  decryptBatch: 'Decrypt batch',
  duplicateClusters: 'Duplicate advisory clusters',
  commitStatus: 'On-chain commit status',
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

function getErrorCode(error: unknown): string | undefined {
  if (isHubError(error)) {
    return error.code;
  }

  if (typeof error === 'object' && error !== null) {
    const maybeCode = (error as { code?: unknown }).code;
    if (typeof maybeCode === 'string' && maybeCode.trim().length > 0) {
      return maybeCode;
    }
  }

  return undefined;
}

function getErrorRemediation(error: unknown): string | undefined {
  const code = getErrorCode(error);
  const remediated = remediationFor(code);
  if (remediated) {
    return remediated;
  }

  if (typeof error === 'object' && error !== null) {
    const maybeRemediation = (error as { remediation?: unknown }).remediation;
    if (typeof maybeRemediation === 'string' && maybeRemediation.trim().length > 0) {
      return maybeRemediation;
    }
  }

  return undefined;
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

function createCommitStatusDiagnostic(message: string): LoadDiagnostic {
  return {
    source: 'commitStatus',
    label: LOAD_SOURCE_LABELS.commitStatus,
    message,
    likelyCause: inferLikelyCause('commitStatus', message),
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

export function LeaderPipelinePanel() {
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id ?? '';

  const [reviewKeywords, setReviewKeywords] = useState<Submission[]>([]);
  const [pendingChain, setPendingChain] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadDiagnostics, setLoadDiagnostics] = useState<LoadDiagnostic[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [txResult, setTxResult] = useState<{ tx_hash: string; committed_count: number } | null>(null);
  const [orgVocabulary, setOrgVocabulary] = useState<Set<string>>(new Set());
  const [keywordCandidates, setKeywordCandidates] = useState<Map<string, KeywordCandidate>>(new Map());
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateClustersResponse | null>(null);
  const [duplicateClustersExpanded, setDuplicateClustersExpanded] = useState(false);
  const [expandedModeratorVotes, setExpandedModeratorVotes] = useState<Record<string, boolean>>({});
  const [expandedNearDupMatches, setExpandedNearDupMatches] = useState<Set<string>>(new Set());
  const [showAllNearDupMatches, setShowAllNearDupMatches] = useState<Set<string>>(new Set());
  const [denyModalSubmissionHash, setDenyModalSubmissionHash] = useState<string | null>(null);
  const [denyModalReason, setDenyModalReason] = useState('rejected');
  const [banModalContributorPubkey, setBanModalContributorPubkey] = useState<string | null>(null);
  const [banModalLoading, setBanModalLoading] = useState(false);
  const [banContributorError, setBanContributorError] = useState<string | null>(null);
  const [deselectedKeywords, setDeselectedKeywords] = useState<Record<string, Set<string>>>({});
  const verifyQueue = useVerifyQueue();

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

  const toggleNearDupMatches = useCallback((submissionHash: string) => {
    setExpandedNearDupMatches((prev) => {
      const next = new Set(prev);
      if (next.has(submissionHash)) {
        next.delete(submissionHash);
      } else {
        next.add(submissionHash);
      }
      return next;
    });
  }, []);

  const toggleNearDupShowAll = useCallback((submissionHash: string) => {
    setShowAllNearDupMatches((prev) => {
      const next = new Set(prev);
      if (next.has(submissionHash)) {
        next.delete(submissionHash);
      } else {
        next.add(submissionHash);
      }
      return next;
    });
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
      const [
        pendingKeywordResult,
        pendingChainResult,
        keywordsResult,
        keywordCandidatesResult,
        duplicateClustersResult,
      ] = await Promise.allSettled([
        getSubmissionsByStatus(orgId, 'pending_keyword'),
        getSubmissionsByStatus(orgId, 'pending_chain'),
        listKeywords(orgId),
        getKeywordCandidates(orgId),
        getDuplicateClusters(orgId, 'pending_chain'),
      ]);

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

      const duplicateClusterSummary = duplicateClustersResult.status === 'fulfilled'
        ? duplicateClustersResult.value
        : null;
      if (duplicateClustersResult.status !== 'fulfilled') {
        diagnostics.push(createLoadDiagnostic('duplicateClusters', duplicateClustersResult.reason));
      }

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
      reconcileSettledHashes(chainQueue.map((submission) => submission.submission_hash));

      setOrgVocabulary(vocabulary);
      setKeywordCandidates(candidateMap);
      setDuplicateClusters(duplicateClusterSummary);
      if (!duplicateClusterSummary || duplicateClusterSummary.clusters.length === 0) {
        setDuplicateClustersExpanded(false);
      }
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
    if (clientState === 'connected') {
      resumeVerifyQueue();
    }
  }, [clientState]);

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

  useEffect(() => {
    if (
      clientState === 'connected'
      && verifyQueue.activeCount === 0
      && verifyQueue.batches.length > 0
    ) {
      void loadAll();
    }
  }, [clientState, verifyQueue.activeCount, verifyQueue.batches.length, loadAll]);

  const handleVerifyAll = useCallback(() => {
    if (!orgId) return;

    const inFlightHashSet = new Set(verifyQueue.inFlightHashes);
    const awaitingSubmissions = reviewKeywords.filter(
      (submission) => !inFlightHashSet.has(submission.submission_hash),
    );

    if (awaitingSubmissions.length === 0) return;

    const client = getMcpClient();
    if (client.state !== 'connected') {
      toast.error('Connect to the MCP server to verify keywords.');
      return;
    }

    const missingPayload = awaitingSubmissions.find((submission) => (
      typeof submission.ciphertext_hex !== 'string'
      || submission.ciphertext_hex.length === 0
      || typeof submission.wrapped_dek_mod !== 'string'
      || submission.wrapped_dek_mod.length === 0
    ));
    if (missingPayload) {
      toast.error(`Missing encrypted payload for ${missingPayload.submission_hash.slice(0, 12)}…; cannot verify.`);
      return;
    }

    const batchInputs: VerificationJobInput[] = [];

    for (const submission of awaitingSubmissions) {
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

      batchInputs.push({
        orgId,
        submissionHash: submission.submission_hash,
        epochId: submission.epoch_id,
        selected: selectedList,
        excluded: toExcludedSuggestionPayload(deselectedItems),
        ciphertextHex: submission.ciphertext_hex as string,
        wrappedDekMod: submission.wrapped_dek_mod as string,
        stackHint: Array.isArray(submission.stack_hint) ? submission.stack_hint : [],
      });
    }

    enqueueVerificationBatch(batchInputs);
    resumeVerifyQueue();
  }, [reviewKeywords, deselectedKeywords, orgId, verifyQueue.inFlightHashes]);

  const handleDenyFinal = useCallback(async (hash: string, reason = 'rejected') => {
    if (!orgId) return;

    setBusy(hash);
    setNotice(null);

    try {
      await denySubmission(orgId, hash, reason);
      setNotice(
        reason === 'duplicate'
          ? `Denied ${hash.slice(0, 12)}… as duplicate`
          : `Denied ${hash.slice(0, 12)}…`,
      );
      await loadAll();
    } catch (err) {
      const message = (err as Error).message;
      const description = getErrorRemediation(err);
      if (description) {
        toast.error(message, { description });
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(null);
    }
  }, [loadAll, orgId]);

  const openBanContributorModal = useCallback((contributorPubkey: string) => {
    setBanContributorError(null);
    setBanModalContributorPubkey(contributorPubkey);
  }, []);

  const handleBanContributor = useCallback(async () => {
    if (!orgId || !banModalContributorPubkey) {
      return;
    }

    const contributorPubkey = banModalContributorPubkey;
    setBanModalLoading(true);
    setNotice(null);
    setBanContributorError(null);

    let chainStepCompleted = false;

    try {
      const members = await listMembers(orgId);
      const targetMember = members.find((member) => member.pubkey === contributorPubkey);
      if (!targetMember) {
        throw new Error(`Contributor ${shortenPubkey(contributorPubkey)} is not a current org member.`);
      }

      const { connectWallet } = await import('@/lib/wallet-connect');
      const walletConn = await connectWallet();
      const msg = buildSetMemberCapabilitiesMsg(
        walletConn.address,
        orgId,
        contributorPubkey,
        false,
        targetMember.can_moderate === true,
      );
      const orgAccount = await resolveOrgAccountForGas();
      await directBroadcast(walletConn.address, [msg], orgAccount);
      chainStepCompleted = true;

      const denyResult = await denyPendingForContributor(orgId, contributorPubkey);
      setBanModalContributorPubkey(null);
      setNotice(
        `Banned ${shortenPubkey(contributorPubkey)}: chain capability revoked and ${denyResult.denied_count} pending submission(s) denied.`,
      );
      await loadAll();
    } catch (error) {
      const message = normalizeErrorMessage(error);
      const failureMessage = chainStepCompleted
        ? `Chain step completed (can_contribute revoked), but hub deny-pending failed: ${message}`
        : `Chain step failed (capability unchanged), so hub deny-pending was not run: ${message}`;
      const description = getErrorRemediation(error);
      setBanContributorError(failureMessage);
      if (description) {
        toast.error(failureMessage, { description });
      } else {
        toast.error(failureMessage);
      }
    } finally {
      setBanModalLoading(false);
    }
  }, [
    banModalContributorPubkey,
    loadAll,
    orgId,
    resolveOrgAccountForGas,
  ]);

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

      try {
        await requestProvisionRecall(orgId);
        toast.success('Recall keys provisioned');
      } catch (err) {
        const message = normalizeErrorMessage(err);
        const code = getErrorCode(err);
        const description = remediationFor(code) ?? (typeof (err as { remediation?: unknown })?.remediation === 'string'
          ? (err as { remediation?: string }).remediation
          : undefined);
        toast.error(`Committed to chain, but recall provisioning failed: ${message}`, description ? { description } : undefined);
      }

      try {
        const statuses = await getCommitStatus(orgId);
        const firstCommitError = statuses.find(
          (entry) => typeof entry.commit_error === 'string' && entry.commit_error.trim().length > 0,
        )?.commit_error;

        setLoadDiagnostics((prev) => {
          const withoutCommitStatus = prev.filter((diag) => diag.source !== 'commitStatus');
          if (!firstCommitError) {
            return withoutCommitStatus;
          }
          return [...withoutCommitStatus, createCommitStatusDiagnostic(firstCommitError)];
        });
      } catch {
        // Best-effort: the chain commit already succeeded.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const description = getErrorRemediation(err);
      if (txToastId !== null) {
        txError(txToastId, message, description);
      } else {
        if (description) {
          toast.error(message, { description });
        } else {
          toast.error(message);
        }
      }
    } finally {
      setBusy(null);
    }
  }, [orgId, pendingChain, resolveOrgAccountForGas, loadAll]);

  const inFlightHashes = useMemo(
    () => new Set(verifyQueue.inFlightHashes),
    [verifyQueue.inFlightHashes],
  );

  const submissionByHash = useMemo(() => {
    const mapped = new Map<string, Submission>();
    for (const submission of [...reviewKeywords, ...pendingChain]) {
      if (!mapped.has(submission.submission_hash)) {
        mapped.set(submission.submission_hash, submission);
      }
    }
    return mapped;
  }, [reviewKeywords, pendingChain]);

  const awaiting = useMemo(
    () => reviewKeywords.filter((submission) => !inFlightHashes.has(submission.submission_hash)),
    [reviewKeywords, inFlightHashes],
  );

  const ready = useMemo(
    () => pendingChain.filter((submission) => !inFlightHashes.has(submission.submission_hash)),
    [pendingChain, inFlightHashes],
  );

  const duplicateClusterCount = duplicateClusters?.clusters.length ?? 0;

  const isVerifying = verifyQueue.batches.length > 0;

  if (!orgId) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Memory approval</h1>
          <p className="text-sm text-wv-dim">
            Approve memories and submit them to chain.
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
          <h1 className="text-3xl font-semibold tracking-tight">Memory approval</h1>
          <p className="text-sm text-wv-dim">
            Connect to the dashboard MCP server in Settings to manage approvals.
          </p>
        </header>
        <div className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 text-sm text-wv-amber">
          <p className="font-medium">No MCP session detected ({clientState}).</p>
          <p className="mt-2">
            Open <a href="/settings" className="font-medium text-wv-amber underline-offset-2 hover:underline">Settings</a> and connect to your running `wevibe-mcp --dashboard` server.
          </p>
          <div className="mt-4">
            <DashboardServerControls variant="inline" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex justify-end">
        <button
          type="button"
          onClick={() => loadAll()}
          disabled={loading}
          className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-text shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

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

      {banContributorError && (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {banContributorError}
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

      <section className="rounded-2xl border border-wv-line bg-wv-panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Awaiting approval</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {awaiting.length} memories awaiting approval
            </p>
            <p className="mt-1 text-xs text-wv-amber">
              Green = already in your keyword set · Blue = commonly suggested by contributors · Yellow = new (joins the set on commit) · Click any keyword to deselect (gray = won’t commit).
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleVerifyAll()}
            disabled={loading || awaiting.length === 0}
            className="inline-flex items-center whitespace-nowrap rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            Approve
          </button>
        </div>

        {awaiting.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories awaiting approval.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {awaiting.map((item) => {
              const extraction = parseExtractionResult(item.extraction_result);
              const itemBusy = busy === item.submission_hash;
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

              return (
                <div key={item.submission_hash} className="rounded-lg border border-[rgba(124,92,255,0.4)] bg-wv-panel p-4">
                  <PreferenceScoreCard confidence={item.preference_confidence} className="mb-3" />
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

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span
                      className="inline-flex items-center rounded-full border border-wv-line bg-wv-panel-2 px-2 py-0.5 font-mono text-xs text-wv-dim"
                      title={item.contributor_pubkey}
                    >
                      Contributor {shortenPubkey(item.contributor_pubkey)}
                    </span>
                    <button
                      type="button"
                      onClick={() => openBanContributorModal(item.contributor_pubkey)}
                      disabled={itemBusy || loading || banModalLoading}
                      className="rounded border border-[rgba(255,107,107,0.42)] bg-[rgba(255,107,107,0.1)] px-2 py-1 text-xs font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
                    >
                      Ban contributor
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
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-wv-line bg-wv-panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-wv-text">Awaiting batch submission</h2>
            <p className="mt-1 text-sm text-wv-dim">
              {ready.length} ready for batch submit
            </p>
            {isVerifying && (
              <p className="mt-1 text-xs text-wv-amber">Waiting for verification to finish…</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => handleSubmitBatch()}
            disabled={busy === 'chain' || loading || ready.length === 0 || isVerifying}
            className="inline-flex items-center rounded-lg bg-wv-green px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:bg-[rgba(54,211,153,0.85)] disabled:cursor-not-allowed disabled:bg-wv-panel-3 disabled:text-wv-dim"
          >
            {busy === 'chain' ? 'Submitting…' : 'Send Batch'}
          </button>
        </div>

        {duplicateClusterCount > 0 && duplicateClusters && (
          <div className="mt-4 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-3 text-sm text-wv-amber">
            <button
              type="button"
              onClick={() => setDuplicateClustersExpanded((prev) => !prev)}
              aria-expanded={duplicateClustersExpanded}
              className="inline-flex items-center gap-2 font-medium text-wv-amber transition hover:text-[rgba(255,178,85,0.9)]"
            >
              <span>⚠ {duplicateClusterCount} near-duplicate cluster(s) detected in this batch</span>
              <span aria-hidden="true" className="text-[10px]">
                {duplicateClustersExpanded ? '▾' : '▸'}
              </span>
            </button>
            {duplicateClustersExpanded && (
              <div className="mt-3 space-y-2 text-xs text-wv-amber">
                {duplicateClusters.clusters.map((cluster, clusterIndex) => (
                  <div
                    key={`${clusterIndex}-${cluster.members.join(':')}`}
                    className="rounded-lg border border-[rgba(255,178,85,0.35)] bg-[rgba(255,178,85,0.1)] px-3 py-2"
                  >
                    <p className="font-medium">Cluster {clusterIndex + 1} · {cluster.size} memories</p>
                    <p className="mt-1 font-mono text-[11px]">
                      {cluster.members.map((memberHash) => shortenHash(memberHash)).join(' · ')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ready.length === 0 && verifyQueue.batches.length === 0 ? (
          <p className="mt-4 text-sm text-wv-dim">No memories ready for batch submit.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {ready.map((item) => {
              const extraction = parseExtractionResult(item.extraction_result);
              const itemBusy = busy === item.submission_hash;
              const nearDupMatches = item.near_dup_matches ?? [];
              const nearDupExpanded = expandedNearDupMatches.has(item.submission_hash);
              const nearDupShowAll = showAllNearDupMatches.has(item.submission_hash);
              const visibleNearDupMatches = nearDupShowAll
                ? nearDupMatches
                : nearDupMatches.slice(0, 10);

              return (
                <div key={item.submission_hash} className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-wv-panel p-4">
                  <PreferenceScoreCard confidence={item.preference_confidence} className="mb-3" />
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

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span
                      className="inline-flex items-center rounded-full border border-wv-line bg-wv-panel-2 px-2 py-0.5 font-mono text-xs text-wv-dim"
                      title={item.contributor_pubkey}
                    >
                      Contributor {shortenPubkey(item.contributor_pubkey)}
                    </span>
                    <button
                      type="button"
                      onClick={() => openBanContributorModal(item.contributor_pubkey)}
                      disabled={itemBusy || loading || banModalLoading}
                      className="rounded border border-[rgba(255,107,107,0.42)] bg-[rgba(255,107,107,0.1)] px-2 py-1 text-xs font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
                    >
                      Ban contributor
                    </button>
                  </div>

                  {nearDupMatches.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.14)] px-3 py-2 text-xs text-wv-amber">
                      <div
                        className="flex flex-wrap items-center gap-2 cursor-pointer select-none"
                        onClick={() => toggleNearDupMatches(item.submission_hash)}
                        role="button"
                        tabIndex={0}
                        aria-expanded={nearDupExpanded}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            if (e.key === ' ') {
                              e.preventDefault();
                            }
                            toggleNearDupMatches(item.submission_hash);
                          }
                        }}
                      >
                        <span className="font-semibold tracking-[0.01em] text-wv-amber">Similar memories</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDenyModalReason('duplicate');
                            setDenyModalSubmissionHash(item.submission_hash);
                          }}
                          disabled={itemBusy || loading}
                          className="inline-flex items-center text-xs font-medium text-wv-red transition hover:text-[rgba(255,107,107,0.85)] disabled:cursor-not-allowed disabled:text-wv-dim"
                        >
                          [remove]
                        </button>
                        <span aria-hidden="true" className="ml-auto inline-flex items-center text-sm font-medium text-wv-amber">
                          {nearDupExpanded ? '⌃' : '⌄'}
                        </span>
                      </div>

                      {nearDupExpanded && (
                        <div className="mt-2 space-y-1.5 text-[11px] text-wv-amber">
                          {visibleNearDupMatches.map((match, matchIndex) => (
                            <p key={`${match.cid}-${matchIndex}`}>
                              {formatSimilarityPercent(match.score)} similar to <span className="font-mono">{shortenHash(match.cid)}</span>
                            </p>
                          ))}
                          {nearDupMatches.length > 10 && !nearDupShowAll && (
                            <button
                              type="button"
                              onClick={() => toggleNearDupShowAll(item.submission_hash)}
                              className="inline-flex items-center text-xs font-medium text-wv-amber transition hover:text-[rgba(255,178,85,0.9)]"
                            >
                              [… show all] ({nearDupMatches.length})
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}

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

            {verifyQueue.batches.map((batch, batchIndex) => (
              <div
                key={batch.batchId}
                className="rounded-lg border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.08)] p-4"
              >
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-wv-violet">
                  Batch {batchIndex + 1} — verifying
                </p>
                <div className="mt-3 space-y-3">
                  {batch.items.map((queueItem) => {
                    const submission = submissionByHash.get(queueItem.submissionHash);
                    const isFailed = queueItem.state === 'failed';
                    return (
                      <div
                        key={`${batch.batchId}-${queueItem.submissionHash}`}
                        className={isFailed
                          ? 'rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.1)] p-4'
                          : 'rounded-lg border border-[rgba(124,92,255,0.35)] bg-wv-panel p-4'}
                      >
                        <div className={`flex flex-wrap items-center gap-2 text-xs ${isFailed ? 'text-wv-red' : 'text-wv-dim'}`}>
                          <span className="font-mono">{queueItem.submissionHash.slice(0, 16)}…</span>
                          <span
                            className={isFailed
                              ? 'rounded-full border border-[rgba(255,107,107,0.45)] bg-[rgba(255,107,107,0.18)] px-2 py-0.5 text-[10px] font-medium text-wv-red'
                              : 'rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.12)] px-2 py-0.5 text-[10px] font-medium text-wv-violet'}
                          >
                            {isFailed ? 'Failed' : 'Verifying'}
                          </span>
                        </div>

                        {submission?.plaintext && (
                          <p className="mt-2 text-sm text-wv-text whitespace-pre-wrap break-words">
                            {submission.plaintext}
                          </p>
                        )}

                        {isFailed && (
                          <>
                            <p className="mt-2 text-sm text-wv-red">{queueItem.reason ?? 'Verification failed'}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  retryVerification(queueItem.submissionHash);
                                  resumeVerifyQueue();
                                }}
                                className="rounded-lg border border-[rgba(124,92,255,0.45)] bg-[rgba(124,92,255,0.12)] px-3 py-1.5 text-xs font-medium text-wv-violet transition hover:bg-[rgba(124,92,255,0.22)]"
                              >
                                Retry
                              </button>
                              <button
                                type="button"
                                onClick={() => removeVerification(queueItem.submissionHash)}
                                className="rounded-lg border border-wv-line px-3 py-1.5 text-xs font-medium text-wv-dim transition hover:text-wv-text"
                              >
                                Dismiss
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={banModalContributorPubkey !== null}
        title="Ban contributor?"
        onClose={() => {
          if (banModalLoading) {
            return;
          }
          setBanModalContributorPubkey(null);
        }}
        footer={(
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setBanModalContributorPubkey(null)}
              disabled={banModalLoading}
              className="rounded-lg border border-wv-line px-3 py-1.5 text-sm font-medium text-wv-dim transition hover:text-wv-text disabled:cursor-not-allowed disabled:text-wv-faint"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void handleBanContributor();
              }}
              disabled={banModalLoading}
              className="rounded-lg border border-[rgba(255,107,107,0.5)] bg-[rgba(255,107,107,0.1)] px-3 py-1.5 text-sm font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.2)] disabled:cursor-not-allowed disabled:border-wv-line disabled:text-wv-dim"
            >
              {banModalLoading ? 'Banning…' : 'Ban contributor'}
            </button>
          </div>
        )}
      >
        {banModalContributorPubkey ? (
          <>
            Ban contributor <span className="font-mono">{shortenPubkey(banModalContributorPubkey)}</span>? This revokes
            their ability to contribute and removes ALL their pending submissions. This cannot be undone.
          </>
        ) : null}
      </Modal>

      <Modal
        open={denyModalSubmissionHash !== null}
        title="Remove submission?"
        onClose={() => {
          setDenyModalSubmissionHash(null);
          setDenyModalReason('rejected');
        }}
        footer={(
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDenyModalSubmissionHash(null);
                setDenyModalReason('rejected');
              }}
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
                const reasonToUse = denyModalReason;
                setDenyModalSubmissionHash(null);
                setDenyModalReason('rejected');
                void handleDenyFinal(hashToDeny, reasonToUse);
              }}
              className="rounded-lg border border-[rgba(255,107,107,0.5)] bg-[rgba(255,107,107,0.1)] px-3 py-1.5 text-sm font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.2)]"
            >
              Remove
            </button>
          </div>
        )}
      >
        Are you sure? This action cannot be undone.
      </Modal>
    </div>
  );
}
