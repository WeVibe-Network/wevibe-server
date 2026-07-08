'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import {
  type KeywordSuggestionPayload,
  type KeywordWeight,
  updateKeywords,
  verifyKeywords,
} from './hub-client';
import { renormalizeFromBase } from './keyword-weights';
import { callMcpTool, getMcpRestState, MCP_ROUTES } from './mcp-rest';

export interface VerificationJobInput {
  orgId: string;
  submissionHash: string;
  epochId: number;
  selected: KeywordWeight[];
  excluded: KeywordSuggestionPayload[];
  ciphertextHex: string;
  wrappedDekMod: string;
  stackHint: string[];
}

type QueueJobStatus = 'queued' | 'running';
type QueueJobStage = 'embedding' | 'verifying' | null;

interface VerificationJob extends VerificationJobInput {
  batchId: string;
  status: QueueJobStatus;
  stage: QueueJobStage;
}

interface BatchRecord {
  batchId: string;
  createdAt: number;
  hashes: string[];
  verified: string[];
}

interface QueueSnapshot {
  batches: {
    batchId: string;
    createdAt: number;
    items: {
      submissionHash: string;
      state: 'pending' | 'embedding' | 'verifying' | 'verified' | 'failed';
      reason?: string;
    }[];
  }[];
  inFlightHashes: string[];
  activeCount: number;
  failedHashes: string[];
}

interface PersistedQueuePayload {
  version: 1;
  backendInstanceId: string | null;
  jobs: VerificationJob[];
  batches: BatchRecord[];
  cachedInputs: VerificationJobInput[];
  failed: { submissionHash: string; reason: string }[];
}

type PersistedQueuePayloadRaw = {
  version?: unknown;
  backendInstanceId?: unknown;
  jobs?: unknown;
  batches?: unknown;
  cachedInputs?: unknown;
  failed?: unknown;
};

type EmbedResult = {
  id: string;
  vector: number[] | null;
  embedding_model_id: string;
  embedding_schema_version: string;
  umbral_capsule: string | null;
  umbral_ciphertext: string | null;
  error?: string;
};

type EmbedResultWithVector = Omit<EmbedResult, 'vector' | 'umbral_capsule' | 'umbral_ciphertext'> & {
  vector: number[];
  umbral_capsule: string;
  umbral_ciphertext: string;
};

const STORAGE_VERSION = 1;
const VERIFY_QUEUE_STORAGE_KEY = 'wevibe.verify-queue.v1';
const BACKEND_INSTANCE_STORAGE_KEY = 'wevibe.backend-instance.v1';

const EMPTY_SERVER_BATCHES: QueueSnapshot['batches'] = [];
Object.freeze(EMPTY_SERVER_BATCHES);

const EMPTY_SERVER_HASHES: string[] = [];
Object.freeze(EMPTY_SERVER_HASHES);

const EMPTY_SERVER_SNAPSHOT = Object.freeze({
  batches: EMPTY_SERVER_BATCHES,
  inFlightHashes: EMPTY_SERVER_HASHES,
  activeCount: 0,
  failedHashes: EMPTY_SERVER_HASHES,
}) as QueueSnapshot;

let jobs: VerificationJob[] = [];
let batches: BatchRecord[] = [];
let failed: Map<string, string> = new Map();
let cachedInputs: Map<string, VerificationJobInput> = new Map();
let isProcessing = false;
let progressToastId: string | number | undefined;
let runTotal = 0;
let runCompleted = 0;
let runHadFailure = false;
let runStage: 'embedding' | 'verifying' = 'embedding';

const listeners = new Set<() => void>();
let cachedSnapshot: QueueSnapshot = EMPTY_SERVER_SNAPSHOT;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStackHint(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function normalizeKeywordWeights(value: unknown): KeywordWeight[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: KeywordWeight[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const keyword = normalizeNonEmptyString(entry.keyword);
    if (!keyword) {
      continue;
    }

    const parsedWeight = typeof entry.weight === 'number' ? entry.weight : Number(entry.weight);
    if (!Number.isFinite(parsedWeight)) {
      continue;
    }

    const parsedBaseWeight = typeof entry.base_weight === 'number'
      ? entry.base_weight
      : Number(entry.base_weight);

    normalized.push({
      keyword,
      weight: parsedWeight,
      base_weight: Number.isFinite(parsedBaseWeight) ? parsedBaseWeight : parsedWeight,
    });
  }

  return normalized;
}

function normalizeExcludedSuggestions(value: unknown): KeywordSuggestionPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: KeywordSuggestionPayload[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const keyword = normalizeNonEmptyString(entry.keyword);
    if (!keyword) {
      continue;
    }

    const parsedWeight = typeof entry.weight === 'number' ? entry.weight : Number(entry.weight);
    if (!Number.isFinite(parsedWeight)) {
      continue;
    }

    const parsedBaseWeight = typeof entry.base_weight === 'number'
      ? entry.base_weight
      : Number(entry.base_weight);

    const rationale = typeof entry.rationale === 'string' && entry.rationale.trim().length > 0
      ? entry.rationale
      : 'excluded';

    normalized.push({
      keyword,
      weight: parsedWeight,
      base_weight: Number.isFinite(parsedBaseWeight) ? parsedBaseWeight : parsedWeight,
      rationale,
    });
  }

  return normalized;
}

function parseVerificationJobInput(raw: unknown): VerificationJobInput | null {
  if (!isRecord(raw)) {
    return null;
  }

  const orgId = normalizeNonEmptyString(raw.orgId);
  const submissionHash = normalizeNonEmptyString(raw.submissionHash);
  const epochIdRaw = typeof raw.epochId === 'number' ? raw.epochId : Number(raw.epochId);
  const ciphertextHex = normalizeNonEmptyString(raw.ciphertextHex);
  const wrappedDekMod = normalizeNonEmptyString(raw.wrappedDekMod);

  if (!orgId || !submissionHash || !Number.isFinite(epochIdRaw) || !ciphertextHex || !wrappedDekMod) {
    return null;
  }

  return {
    orgId,
    submissionHash,
    epochId: epochIdRaw,
    selected: normalizeKeywordWeights(raw.selected),
    excluded: normalizeExcludedSuggestions(raw.excluded),
    ciphertextHex,
    wrappedDekMod,
    stackHint: normalizeStackHint(raw.stackHint),
  };
}

function parseVerificationJob(raw: unknown): VerificationJob | null {
  if (!isRecord(raw)) {
    return null;
  }

  const input = parseVerificationJobInput(raw);
  if (!input) {
    return null;
  }

  const status: QueueJobStatus = raw.status === 'running' ? 'running' : 'queued';
  const stage: QueueJobStage = raw.stage === 'embedding' || raw.stage === 'verifying'
    ? raw.stage
    : null;
  const batchId = normalizeNonEmptyString(raw.batchId) ?? `legacy-${input.submissionHash}`;

  return {
    ...input,
    batchId,
    status,
    stage,
  };
}

function normalizeUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const normalizedEntry = normalizeNonEmptyString(entry);
    if (!normalizedEntry || seen.has(normalizedEntry)) {
      continue;
    }

    seen.add(normalizedEntry);
    normalized.push(normalizedEntry);
  }

  return normalized;
}

function parseBatchRecord(raw: unknown): BatchRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const batchId = normalizeNonEmptyString(raw.batchId);
  const createdAtRaw = typeof raw.createdAt === 'number' ? raw.createdAt : Number(raw.createdAt);
  if (!batchId || !Number.isFinite(createdAtRaw)) {
    return null;
  }

  const hashes = normalizeUniqueStringArray(raw.hashes);
  if (hashes.length === 0) {
    return null;
  }

  const hashSet = new Set(hashes);
  const verified = normalizeUniqueStringArray(raw.verified).filter((hash) => hashSet.has(hash));

  return {
    batchId,
    createdAt: createdAtRaw,
    hashes,
    verified,
  };
}

function normalizeVerificationInput(input: VerificationJobInput): VerificationJobInput | null {
  return parseVerificationJobInput(input);
}

function createBatchId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `batch-${Date.now()}-${suffix}`;
}

function normalizeFailureEntries(raw: unknown): Map<string, string> {
  const normalized = new Map<string, string>();
  if (!Array.isArray(raw)) {
    return normalized;
  }

  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }

    const submissionHash = normalizeNonEmptyString(entry.submissionHash);
    const reason = normalizeNonEmptyString(entry.reason);
    if (!submissionHash || !reason) {
      continue;
    }

    normalized.set(submissionHash, reason);
  }

  return normalized;
}

function getCurrentBackendInstanceId(): string | null {
  if (!isBrowser()) {
    return null;
  }

  try {
    return normalizeOptionalString(window.localStorage.getItem(BACKEND_INSTANCE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function findBatchIndexByHash(submissionHash: string): number {
  return batches.findIndex((batch) => batch.hashes.includes(submissionHash));
}

function findBatchIndexById(batchId: string): number {
  return batches.findIndex((batch) => batch.batchId === batchId);
}

function createBatchRecord(batchId: string, hashes: string[], createdAt = Date.now()): BatchRecord {
  const hashSet = new Set(hashes);
  return {
    batchId,
    createdAt,
    hashes: Array.from(hashSet),
    verified: [],
  };
}

function isBatchConcluded(batch: BatchRecord): boolean {
  if (batch.hashes.length === 0) {
    return true;
  }

  const verifiedSet = new Set(batch.verified);
  return batch.hashes.every((hash) => verifiedSet.has(hash));
}

function createBatchForHash(submissionHash: string): BatchRecord {
  const batch = createBatchRecord(createBatchId(), [submissionHash]);
  batches.push(batch);
  return batch;
}

function ensureHashInBatch(submissionHash: string, preferredBatchId?: string): BatchRecord {
  const existingByHashIndex = findBatchIndexByHash(submissionHash);
  if (existingByHashIndex >= 0) {
    return batches[existingByHashIndex];
  }

  if (preferredBatchId) {
    const preferredBatchIndex = findBatchIndexById(preferredBatchId);
    if (preferredBatchIndex >= 0) {
      batches[preferredBatchIndex].hashes.push(submissionHash);
      return batches[preferredBatchIndex];
    }

    const newBatch = createBatchRecord(preferredBatchId, [submissionHash]);
    batches.push(newBatch);
    return newBatch;
  }

  return createBatchForHash(submissionHash);
}

function markBatchHashVerified(batchId: string, submissionHash: string): void {
  const batch = ensureHashInBatch(submissionHash, batchId);
  if (!batch.verified.includes(submissionHash)) {
    batch.verified.push(submissionHash);
  }
}

function removeHashFromBatches(submissionHash: string): void {
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (!batch.hashes.includes(submissionHash)) {
      continue;
    }

    batch.hashes = batch.hashes.filter((hash) => hash !== submissionHash);
    batch.verified = batch.verified.filter((hash) => hash !== submissionHash);

    if (batch.hashes.length === 0 || isBatchConcluded(batch)) {
      batches.splice(index, 1);
    }
  }
}

export function reconcileSettledHashes(pendingChainHashes: string[]): void {
  if (!isBrowser() || pendingChainHashes.length === 0 || batches.length === 0) {
    return;
  }

  const pendingChainHashSet = new Set(
    pendingChainHashes
      .map((hash) => hash.trim())
      .filter((hash) => hash.length > 0),
  );

  if (pendingChainHashSet.size === 0) {
    return;
  }

  let removed = false;
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (!batch.hashes.every((hash) => pendingChainHashSet.has(hash))) {
      continue;
    }

    batches.splice(index, 1);
    removed = true;
  }

  if (!removed) {
    return;
  }

  persistState();
  notify();
}

function normalizeLoadedBatches(rawBatches: BatchRecord[]): BatchRecord[] {
  const sorted = [...rawBatches].sort((left, right) => left.createdAt - right.createdAt);
  const normalized: BatchRecord[] = [];
  const seenBatchIds = new Set<string>();
  const assignedHashes = new Set<string>();

  for (const rawBatch of sorted) {
    if (seenBatchIds.has(rawBatch.batchId)) {
      continue;
    }

    const hashes = rawBatch.hashes.filter((hash) => {
      if (assignedHashes.has(hash)) {
        return false;
      }
      assignedHashes.add(hash);
      return true;
    });

    if (hashes.length === 0) {
      continue;
    }

    const hashSet = new Set(hashes);
    const verified = rawBatch.verified.filter((hash) => hashSet.has(hash));

    normalized.push({
      batchId: rawBatch.batchId,
      createdAt: rawBatch.createdAt,
      hashes,
      verified,
    });
    seenBatchIds.add(rawBatch.batchId);
  }

  return normalized.filter((batch) => !isBatchConcluded(batch));
}

function rebuildSnapshot(): void {
  const jobByHash = new Map<string, VerificationJob>();
  for (const job of jobs) {
    if (!jobByHash.has(job.submissionHash)) {
      jobByHash.set(job.submissionHash, job);
    }
  }

  const sortedBatches = [...batches].sort((left, right) => left.createdAt - right.createdAt);
  const snapshotBatches: QueueSnapshot['batches'] = sortedBatches.map((batch) => {
    const verifiedHashes = new Set(batch.verified);
    const items = batch.hashes.map((submissionHash) => {
      const failedReason = failed.get(submissionHash);
      if (failedReason) {
        return {
          submissionHash,
          state: 'failed' as const,
          reason: failedReason,
        };
      }

      const job = jobByHash.get(submissionHash);
      if (job) {
        if (job.status === 'running' && job.stage === 'embedding') {
          return { submissionHash, state: 'embedding' as const };
        }

        if (job.status === 'running' && job.stage === 'verifying') {
          return { submissionHash, state: 'verifying' as const };
        }

        return { submissionHash, state: 'pending' as const };
      }

      if (verifiedHashes.has(submissionHash)) {
        return { submissionHash, state: 'verified' as const };
      }

      return { submissionHash, state: 'pending' as const };
    });

    Object.freeze(items);
    return Object.freeze({
      batchId: batch.batchId,
      createdAt: batch.createdAt,
      items,
    });
  });
  Object.freeze(snapshotBatches);

  const inFlightHashSet = new Set<string>();
  for (const batch of sortedBatches) {
    for (const hash of batch.hashes) {
      inFlightHashSet.add(hash);
    }
  }
  const inFlightHashes = Array.from(inFlightHashSet);
  Object.freeze(inFlightHashes);

  const failedHashes = Array.from(failed.keys());
  Object.freeze(failedHashes);

  cachedSnapshot = Object.freeze({
    batches: snapshotBatches,
    inFlightHashes,
    activeCount: jobs.length,
    failedHashes,
  }) as QueueSnapshot;
}

function notify(): void {
  rebuildSnapshot();
  listeners.forEach((listener) => listener());
}

function persistState(): void {
  if (!isBrowser()) {
    return;
  }

  try {
    const payload: PersistedQueuePayload = {
      version: STORAGE_VERSION,
      backendInstanceId: getCurrentBackendInstanceId(),
      jobs,
      batches,
      cachedInputs: Array.from(cachedInputs.values()),
      failed: Array.from(failed.entries()).map(([submissionHash, reason]) => ({
        submissionHash,
        reason,
      })),
    };

    window.localStorage.setItem(VERIFY_QUEUE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // no-op on storage quota or serialization failures
  }
}

function clearPersistedQueueState(): void {
  if (!isBrowser()) {
    return;
  }

  try {
    window.localStorage.removeItem(VERIFY_QUEUE_STORAGE_KEY);
  } catch {
    // no-op on storage failures
  }
}

function loadPersistedState(): void {
  if (!isBrowser()) {
    rebuildSnapshot();
    return;
  }

  try {
    const raw = window.localStorage.getItem(VERIFY_QUEUE_STORAGE_KEY);
    if (!raw) {
      rebuildSnapshot();
      return;
    }

    const parsed = JSON.parse(raw) as PersistedQueuePayloadRaw;
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) {
      clearPersistedQueueState();
      rebuildSnapshot();
      return;
    }

    const currentBackendInstanceId = getCurrentBackendInstanceId();
    const storedBackendInstanceId = normalizeOptionalString(parsed.backendInstanceId);
    if (
      currentBackendInstanceId
      && storedBackendInstanceId
      && currentBackendInstanceId !== storedBackendInstanceId
    ) {
      clearPersistedQueueState();
      jobs = [];
      batches = [];
      failed = new Map();
      cachedInputs = new Map();
      rebuildSnapshot();
      return;
    }

    const parsedJobs = Array.isArray(parsed.jobs)
      ? parsed.jobs
        .map((entry) => parseVerificationJob(entry))
        .filter((entry): entry is VerificationJob => entry !== null)
      : [];

    jobs = parsedJobs.map((job) => ({
      ...job,
      status: 'queued',
      stage: null,
    }));

    const parsedCachedInputs = Array.isArray(parsed.cachedInputs)
      ? parsed.cachedInputs
        .map((entry) => parseVerificationJobInput(entry))
        .filter((entry): entry is VerificationJobInput => entry !== null)
      : [];

    cachedInputs = new Map();
    for (const entry of parsedCachedInputs) {
      cachedInputs.set(entry.submissionHash, entry);
    }
    for (const job of jobs) {
      cachedInputs.set(job.submissionHash, {
        orgId: job.orgId,
        submissionHash: job.submissionHash,
        epochId: job.epochId,
        selected: job.selected,
        excluded: job.excluded,
        ciphertextHex: job.ciphertextHex,
        wrappedDekMod: job.wrappedDekMod,
        stackHint: job.stackHint,
      });
    }

    failed = normalizeFailureEntries(parsed.failed);

    const parsedBatches = Array.isArray(parsed.batches)
      ? parsed.batches
        .map((entry) => parseBatchRecord(entry))
        .filter((entry): entry is BatchRecord => entry !== null)
      : [];

    batches = normalizeLoadedBatches(parsedBatches);

    for (const job of jobs) {
      const batch = ensureHashInBatch(job.submissionHash, job.batchId);
      job.batchId = batch.batchId;
    }

    for (const failedHash of failed.keys()) {
      ensureHashInBatch(failedHash);
    }

    batches = batches.filter((batch) => !isBatchConcluded(batch));
    rebuildSnapshot();
  } catch {
    jobs = [];
    batches = [];
    failed = new Map();
    cachedInputs = new Map();
    rebuildSnapshot();
  }
}

function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return 'Unknown verification error';
}

function ensureSingleEmbedResult(
  submissionHash: string,
  result: unknown,
): EmbedResultWithVector {
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error('Embedding output mismatch; expected exactly one result');
  }

  const entry = result[0];
  if (!entry || typeof entry !== 'object') {
    throw new Error('Embedding output mismatch; result payload was malformed');
  }

  const candidate = entry as EmbedResult;
  if (candidate.id !== submissionHash) {
    throw new Error('Embedding output mismatch; submission hash did not match');
  }

  if (!Array.isArray(candidate.vector)) {
    throw new Error(
      typeof candidate.error === 'string' && candidate.error.trim().length > 0
        ? candidate.error
        : 'Embedding failed; no vector returned',
    );
  }

  const umbralCapsule = normalizeNonEmptyString(candidate.umbral_capsule);
  const umbralCiphertext = normalizeNonEmptyString(candidate.umbral_ciphertext);
  if (!umbralCapsule || !umbralCiphertext) {
    throw new Error(
      typeof candidate.error === 'string' && candidate.error.trim().length > 0
        ? candidate.error
        : 'Embedding failed; no umbral capsule returned',
    );
  }

  return {
    ...candidate,
    vector: candidate.vector,
    umbral_capsule: umbralCapsule,
    umbral_ciphertext: umbralCiphertext,
  };
}

function removeJob(submissionHash: string): void {
  jobs = jobs.filter((job) => job.submissionHash !== submissionHash);
}

function finalizeProgressToast(): void {
  if (progressToastId === undefined) {
    return;
  }

  if (runHadFailure) {
    toast.error(`Verification finished — ${runCompleted}/${runTotal} succeeded, ${runTotal - runCompleted} failed.`, {
      id: progressToastId,
    });
  } else {
    toast.success(`All keywords verified — ${runCompleted}/${runTotal}.`, {
      id: progressToastId,
    });
  }

  progressToastId = undefined;
}

function refreshProgressToast(): void {
  if (progressToastId === undefined) {
    return;
  }

  const n = Math.min(runCompleted + 1, runTotal);
  const text = runStage === 'verifying'
    ? `Verifying ${n} / ${runTotal} on the hub…`
    : `Embedding retrieval cards… ${n} / ${runTotal}`;

  toast.loading(text, { id: progressToastId });
}

async function runJob(job: VerificationJob): Promise<void> {
  let succeeded = false;

  try {
    await updateKeywords(
      job.orgId,
      job.submissionHash,
      renormalizeFromBase(job.selected),
      job.excluded,
    );

    job.stage = 'embedding';
    runStage = 'embedding';
    persistState();
    notify();

    refreshProgressToast();

    const embedBatch = await callMcpTool<EmbedResult[]>(MCP_ROUTES.embedRetrievalCard, {
      org_id: job.orgId,
      items: [{
        id: job.submissionHash,
        ciphertext_hex: job.ciphertextHex,
        wrapped_dek_mod: job.wrappedDekMod,
        stack_hint: job.stackHint,
        epoch_id: job.epochId,
      }],
    });

    const embed = ensureSingleEmbedResult(job.submissionHash, embedBatch);

    job.stage = 'verifying';
    runStage = 'verifying';
    persistState();
    notify();

    refreshProgressToast();

    const verifyResult = await verifyKeywords(job.orgId, [{
      submission_hash: job.submissionHash,
      vector: embed.vector,
      embedding_model_id: embed.embedding_model_id,
      embedding_schema_version: embed.embedding_schema_version,
      umbral_capsule: embed.umbral_capsule,
      umbral_ciphertext: embed.umbral_ciphertext,
    }]);

    if (!Array.isArray(verifyResult) || verifyResult.length !== 1) {
      throw new Error('Verification output mismatch; expected exactly one result');
    }

    const [singleResult] = verifyResult;
    if (!singleResult.passed) {
      throw new Error(singleResult.error?.trim() || 'Verification failed');
    }

    failed.delete(job.submissionHash);
    markBatchHashVerified(job.batchId, job.submissionHash);
    cachedInputs.delete(job.submissionHash);
    runCompleted += 1;
    succeeded = true;
  } catch (error) {
    runHadFailure = true;
    const reason = normalizeErrorReason(error);
    failed.set(job.submissionHash, reason);
    toast.error(`Verification failed for ${job.submissionHash.slice(0, 12)}…`, {
      description: reason,
      duration: 8000,
    });
  } finally {
    removeJob(job.submissionHash);
    if (!succeeded && !cachedInputs.has(job.submissionHash)) {
      cachedInputs.set(job.submissionHash, {
        orgId: job.orgId,
        submissionHash: job.submissionHash,
        epochId: job.epochId,
        selected: job.selected,
        excluded: job.excluded,
        ciphertextHex: job.ciphertextHex,
        wrappedDekMod: job.wrappedDekMod,
        stackHint: job.stackHint,
      });
    }
    isProcessing = false;
    persistState();
    notify();
    processNext();
  }
}

function processNext(): void {
  if (!isBrowser() || isProcessing) {
    return;
  }

  if (getMcpRestState() !== 'connected') {
    return;
  }

  const nextJob = jobs.find((job) => job.status === 'queued');
  if (!nextJob) {
    finalizeProgressToast();
    return;
  }

  if (progressToastId === undefined) {
    runTotal = jobs.length;
    runCompleted = 0;
    runHadFailure = false;
    runStage = 'embedding';
    progressToastId = toast.loading(`Embedding retrieval cards… 0 / ${runTotal}`);
  }

  nextJob.status = 'running';
  nextJob.stage = null;
  isProcessing = true;
  persistState();
  notify();
  void runJob(nextJob);
}

export function enqueueVerificationBatch(inputs: VerificationJobInput[]): void {
  if (!isBrowser() || inputs.length === 0) {
    return;
  }

  const normalizedInputs = inputs
    .map((input) => normalizeVerificationInput(input))
    .filter((input): input is VerificationJobInput => input !== null);

  if (normalizedInputs.length === 0) {
    return;
  }

  const blockedHashes = new Set<string>();
  for (const job of jobs) {
    blockedHashes.add(job.submissionHash);
  }
  for (const batch of batches) {
    for (const hash of batch.hashes) {
      blockedHashes.add(hash);
    }
  }

  const acceptedInputs: VerificationJobInput[] = [];
  for (const input of normalizedInputs) {
    if (blockedHashes.has(input.submissionHash)) {
      continue;
    }

    blockedHashes.add(input.submissionHash);
    acceptedInputs.push(input);
  }

  if (acceptedInputs.length === 0) {
    return;
  }

  const createdAt = Date.now();
  const batchId = createBatchId();
  const hashes = acceptedInputs.map((input) => input.submissionHash);
  batches.push(createBatchRecord(batchId, hashes, createdAt));

  for (const input of acceptedInputs) {
    cachedInputs.set(input.submissionHash, input);
    failed.delete(input.submissionHash);
    jobs.push({
      ...input,
      epochId: input.epochId,
      batchId,
      status: 'queued',
      stage: null,
    });
  }

  if (progressToastId !== undefined) {
    runTotal += acceptedInputs.length;
    refreshProgressToast();
  }

  persistState();
  notify();
  processNext();
}

export function resumeVerifyQueue(): void {
  processNext();
}

export function retryVerification(submissionHash: string): void {
  if (!isBrowser()) {
    return;
  }

  const normalizedSubmissionHash = submissionHash.trim();
  if (!normalizedSubmissionHash) {
    return;
  }

  failed.delete(normalizedSubmissionHash);

  if (jobs.some((job) => job.submissionHash === normalizedSubmissionHash)) {
    persistState();
    notify();
    processNext();
    return;
  }

  const cachedInput = cachedInputs.get(normalizedSubmissionHash);
  if (!cachedInput) {
    persistState();
    notify();
    return;
  }

  const existingBatchIndex = findBatchIndexByHash(normalizedSubmissionHash);
  const batchId = existingBatchIndex >= 0
    ? batches[existingBatchIndex].batchId
    : createBatchForHash(normalizedSubmissionHash).batchId;

  if (existingBatchIndex >= 0) {
    batches[existingBatchIndex].verified = batches[existingBatchIndex].verified
      .filter((hash) => hash !== normalizedSubmissionHash);
  }

  jobs.push({
    ...cachedInput,
    epochId: cachedInput.epochId,
    batchId,
    status: 'queued',
    stage: null,
  });

  persistState();
  notify();
  processNext();
}

export function removeVerification(submissionHash: string): void {
  if (!isBrowser()) {
    return;
  }

  const normalizedSubmissionHash = submissionHash.trim();
  if (!normalizedSubmissionHash) {
    return;
  }

  removeJob(normalizedSubmissionHash);
  failed.delete(normalizedSubmissionHash);
  cachedInputs.delete(normalizedSubmissionHash);
  removeHashFromBatches(normalizedSubmissionHash);

  persistState();
  notify();
}

function getQueueSnapshot(): QueueSnapshot {
  if (!isBrowser()) {
    return EMPTY_SERVER_SNAPSHOT;
  }

  return cachedSnapshot;
}

export function getServerSnapshot(): QueueSnapshot {
  return EMPTY_SERVER_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVerifyQueue() {
  return useSyncExternalStore(subscribe, getQueueSnapshot, getServerSnapshot);
}

loadPersistedState();
