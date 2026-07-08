'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { type ExtractionDraft, saveDraft } from './draft-store';
import type { MemoryCandidate } from './session-types';

export interface ExtractionJobInput {
  sessionId: string;
  pubkeyHex: string;
  transcript: string;
  title: string;
  directory: string;
  model: string;
  orgId?: string;
}

export interface ParkedExtractionJob {
  job_id: string;
  session_id: string;
  lapsed_model: string;
  proposed_paid_slug: string;
  http_status?: number;
  body_snippet?: string;
  started_at?: string;
}

type QueueJobStatus = 'queued' | 'running';

interface ExtractionJob extends ExtractionJobInput {
  status: QueueJobStatus;
  chunksDone?: number;
  chunksTotal?: number;
  resumeJobId?: string;
  resumeExtractionMeta?: ExtractionDraft['extractionMeta'];
  isResume?: boolean;
}

interface ParkedJobContext {
  pubkeyHex: string;
  title: string;
  directory: string;
}

interface QueueSnapshot {
  jobs: { sessionId: string; status: QueueJobStatus; chunksDone?: number; chunksTotal?: number }[];
  activeCount: number;
  failedSessions: { sessionId: string; reason: string }[];
  parkedJobs: ParkedExtractionJob[];
}

interface EnqueueResponseBody {
  job_id: string;
  extraction_meta: ExtractionDraft['extractionMeta'];
}

interface StatusResponseBody {
  status: 'running' | 'done' | 'error' | 'awaiting_decision';
  chunks_done: number;
  chunks_total: number;
  memories?: MemoryCandidate[];
  empty_reason?: string;
  error?: string;
  failure?: {
    http_status?: number;
    body_snippet?: string;
    lapsed_model?: string;
    proposed_paid_slug?: string;
  };
}

interface ParkedExtractResponseBody {
  parked?: Array<Partial<ParkedExtractionJob> & { updated_at?: string }>;
}

interface ExtractErrorBody {
  error?: string;
  code?: string;
}

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_MS = 20 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const PARKED_CONTEXT_STORAGE_KEY = 'wevibe.extraction.parked-context.v1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMPTY_SERVER_JOBS: QueueSnapshot['jobs'] = [];
Object.freeze(EMPTY_SERVER_JOBS);

const EMPTY_SERVER_FAILED_SESSIONS: QueueSnapshot['failedSessions'] = [];
Object.freeze(EMPTY_SERVER_FAILED_SESSIONS);

const EMPTY_SERVER_PARKED_JOBS: QueueSnapshot['parkedJobs'] = [];
Object.freeze(EMPTY_SERVER_PARKED_JOBS);

const EMPTY_SERVER_SNAPSHOT = Object.freeze({
  jobs: EMPTY_SERVER_JOBS,
  activeCount: 0,
  failedSessions: EMPTY_SERVER_FAILED_SESSIONS,
  parkedJobs: EMPTY_SERVER_PARKED_JOBS,
}) as QueueSnapshot;

let jobs: ExtractionJob[] = [];
let failedSessions: Map<string, string> = new Map();
let parkedJobs: Map<string, ParkedExtractionJob> = new Map();
let parkedJobContexts: Map<string, ParkedJobContext> = new Map();
let isProcessing = false;
let persistentToastId: string | number | undefined;
let toastSequence = 0;

const listeners = new Set<() => void>();
let cachedSnapshot: QueueSnapshot = EMPTY_SERVER_SNAPSHOT;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function toTimestamp(value?: string): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeParkedJob(raw: Partial<ParkedExtractionJob>): ParkedExtractionJob | null {
  if (typeof raw.job_id !== 'string' || raw.job_id.trim().length === 0) {
    return null;
  }
  if (typeof raw.session_id !== 'string' || raw.session_id.trim().length === 0) {
    return null;
  }

  const lapsedModel =
    typeof raw.lapsed_model === 'string' && raw.lapsed_model.trim().length > 0
      ? raw.lapsed_model
      : '';
  const proposedPaidSlug =
    typeof raw.proposed_paid_slug === 'string' && raw.proposed_paid_slug.trim().length > 0
      ? raw.proposed_paid_slug
      : '';

  return {
    job_id: raw.job_id,
    session_id: raw.session_id,
    lapsed_model: lapsedModel,
    proposed_paid_slug: proposedPaidSlug,
    ...(typeof raw.http_status === 'number' ? { http_status: raw.http_status } : {}),
    ...(typeof raw.body_snippet === 'string' && raw.body_snippet.length > 0 ? { body_snippet: raw.body_snippet } : {}),
    ...(typeof raw.started_at === 'string' && raw.started_at.trim().length > 0 ? { started_at: raw.started_at } : {}),
  };
}

function rememberParkedContext(input: Pick<ExtractionJobInput, 'sessionId' | 'pubkeyHex' | 'title' | 'directory'>): void {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return;
  }

  parkedJobContexts.set(sessionId, {
    pubkeyHex: input.pubkeyHex,
    title: input.title,
    directory: input.directory,
  });

  if (!isBrowser()) {
    return;
  }

  const payload: Record<string, ParkedJobContext> = {};
  for (const [storedSessionId, context] of parkedJobContexts.entries()) {
    payload[storedSessionId] = context;
  }

  try {
    window.localStorage.setItem(PARKED_CONTEXT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // best-effort only
  }
}

function parkedContextForSession(sessionId: string): ParkedJobContext | null {
  const inMemory = parkedJobContexts.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!isBrowser()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(PARKED_CONTEXT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const entry = (parsed as Record<string, unknown>)[sessionId];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.pubkeyHex !== 'string' || record.pubkeyHex.trim().length === 0) {
      return null;
    }

    const context: ParkedJobContext = {
      pubkeyHex: record.pubkeyHex,
      title: typeof record.title === 'string' ? record.title : '',
      directory: typeof record.directory === 'string' ? record.directory : '',
    };
    parkedJobContexts.set(sessionId, context);
    return context;
  } catch {
    return null;
  }
}

function showExtractionErrorToast(sessionId: string, reason: string): void {
  toast.error(`Extraction failed for session ${sessionId}`, {
    description: reason,
    duration: 8000,
  });
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ExtractErrorBody;
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      return payload.error;
    }
  } catch {
    // keep fallback
  }

  return fallback;
}

function rebuildSnapshot(): void {
  const snapshotJobs = jobs.map(({ sessionId, status, chunksDone, chunksTotal }) => ({
    sessionId,
    status,
    chunksDone,
    chunksTotal,
  }));
  Object.freeze(snapshotJobs);
  const snapshotFailedSessions = Array.from(failedSessions.entries()).map(([sessionId, reason]) => ({
    sessionId,
    reason,
  }));
  Object.freeze(snapshotFailedSessions);
  const snapshotParkedJobs = Array.from(parkedJobs.values()).sort((a, b) => {
    const aTimestamp = toTimestamp(a.started_at);
    const bTimestamp = toTimestamp(b.started_at);
    if (aTimestamp !== null && bTimestamp !== null) {
      return bTimestamp - aTimestamp;
    }
    if (aTimestamp !== null) {
      return -1;
    }
    if (bTimestamp !== null) {
      return 1;
    }
    return a.session_id.localeCompare(b.session_id);
  });
  Object.freeze(snapshotParkedJobs);
  cachedSnapshot = Object.freeze({
    jobs: snapshotJobs,
    activeCount: snapshotJobs.length,
    failedSessions: snapshotFailedSessions,
    parkedJobs: snapshotParkedJobs,
  }) as QueueSnapshot;
}

function notify(): void {
  rebuildSnapshot();
  listeners.forEach((listener) => listener());
}

function updatePersistentToast(): void {
  if (!isBrowser()) {
    return;
  }

  const activeCount = jobs.length;
  const parkedCount = parkedJobs.size;
  if (activeCount > 0) {
    let message = `You have ${activeCount} session${activeCount === 1 ? '' : 's'} extracting…`;
    if (activeCount === 1) {
      const [activeJob] = jobs;
      if (typeof activeJob?.chunksTotal === 'number' && activeJob.chunksTotal > 0) {
        const chunksDone = typeof activeJob.chunksDone === 'number' ? activeJob.chunksDone : 0;
        message += ` (chunk ${chunksDone}/${activeJob.chunksTotal})`;
      }
    }
    if (persistentToastId === undefined) {
      toastSequence += 1;
      persistentToastId = `wevibe-extraction-queue-${Date.now()}-${toastSequence}`;
    }
    toast.loading(message, { id: persistentToastId });
    return;
  }

  if (persistentToastId !== undefined) {
    if (parkedCount > 0) {
      toast.warning(
        `Extraction paused for ${parkedCount} session${parkedCount === 1 ? '' : 's'} — choose a model to continue`,
        {
          id: persistentToastId,
          duration: 8000,
        },
      );
    } else {
      toast.success('Extraction complete — review your memories', { id: persistentToastId });
    }
    persistentToastId = undefined;
  }
}

async function resolveJobPollingTarget(
  job: ExtractionJob,
): Promise<{ jobId: string; baseMeta: ExtractionDraft['extractionMeta'] | undefined } | null> {
  if (typeof job.resumeJobId === 'string' && job.resumeJobId.trim().length > 0) {
    return {
      jobId: job.resumeJobId,
      baseMeta: job.resumeExtractionMeta,
    };
  }

  const requestBody: {
    transcript: string;
    title: string;
    directory: string;
    model: string;
    session_id: string;
    org_id?: string;
  } = {
    transcript: job.transcript,
    title: job.title,
    directory: job.directory,
    model: job.model,
    session_id: job.sessionId,
  };

  if (job.orgId && job.orgId.trim().length > 0) {
    requestBody.org_id = job.orgId.trim();
  }

  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    let providerNotConfiguredMessage: string | null = null;
    let payload: ExtractErrorBody | null = null;

    try {
      payload = (await response.json()) as ExtractErrorBody;
      if (payload.code === 'provider_not_configured') {
        providerNotConfiguredMessage = typeof payload.error === 'string' && payload.error.trim().length > 0
          ? payload.error
          : 'LLM provider not configured';
      }
    } catch {
      // fall back to generic extraction failure toast
    }

    if (providerNotConfiguredMessage) {
      toast.error(providerNotConfiguredMessage, {
        duration: 8000,
      });
      return null;
    }

    const errorMessage =
      payload && typeof payload.error === 'string' && payload.error.trim().length > 0
        ? payload.error
        : `Extraction request failed with status ${response.status}`;

    throw new Error(errorMessage);
  }

  const enqueue = (await response.json()) as Partial<EnqueueResponseBody>;
  if (typeof enqueue.job_id !== 'string' || !enqueue.job_id) {
    throw new Error('Extraction did not start (no job id)');
  }

  return {
    jobId: enqueue.job_id,
    baseMeta: enqueue.extraction_meta,
  };
}

function buildAwaitingDecisionJob(
  job: ExtractionJob,
  jobId: string,
  failure: StatusResponseBody['failure'],
): ParkedExtractionJob {
  const current = parkedJobs.get(job.sessionId);
  const normalized = normalizeParkedJob({
    job_id: jobId,
    session_id: job.sessionId,
    lapsed_model: failure?.lapsed_model,
    proposed_paid_slug: failure?.proposed_paid_slug,
    http_status: failure?.http_status,
    body_snippet: failure?.body_snippet,
    started_at: current?.started_at,
  });

  if (normalized) {
    return normalized;
  }

  return {
    job_id: jobId,
    session_id: job.sessionId,
    lapsed_model: job.model,
    proposed_paid_slug: '',
  };
}

function persistDoneExtraction(
  job: ExtractionJob,
  status: Partial<StatusResponseBody>,
  baseMeta: ExtractionDraft['extractionMeta'] | undefined,
): void {
  if (!Array.isArray(status.memories)) {
    throw new Error('Extraction response missing memories array');
  }
  const extractionMeta = {
    ...(baseMeta ?? {}),
    ...(status.empty_reason ? { empty_reason: status.empty_reason } : {}),
  } as ExtractionDraft['extractionMeta'];
  const emptyReason = extractionMeta?.empty_reason;
  if (
    status.memories.length === 0
    && (emptyReason === 'off_task_output' || emptyReason === 'unparseable_output')
  ) {
    failedSessions.set(
      job.sessionId,
      'The model returned output we could not extract memories from. Retry to try again.',
    );
  } else {
    saveDraft(job.pubkeyHex, {
      sessionId: job.sessionId,
      sessionTitle: job.title,
      sessionDirectory: job.directory,
      memories: status.memories as MemoryCandidate[],
      extractionMeta,
      createdAt: Date.now(),
    });
  }
}

async function pollJob(
  job: ExtractionJob,
  pollTarget: { jobId: string; baseMeta: ExtractionDraft['extractionMeta'] | undefined },
): Promise<'done' | 'parked'> {
  const deadline = Date.now() + MAX_POLL_MS;
  let consecutiveFailures = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() > deadline) {
      throw new Error('Extraction timed out — the session may be too large; retry to try again');
    }

    let statusResp: Response;
    try {
      statusResp = await fetch(`/api/extract/status?job_id=${encodeURIComponent(pollTarget.jobId)}`, {
        method: 'GET',
      });
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      continue;
    }

    if (!statusResp.ok) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        let msg = `Extraction status check failed with status ${statusResp.status}`;
        try {
          const b = (await statusResp.json()) as ExtractErrorBody;
          if (typeof b.error === 'string' && b.error.trim()) {
            msg = b.error;
          }
        } catch {
          // keep generic
        }
        throw new Error(msg);
      }
      continue;
    }

    consecutiveFailures = 0;
    const status = (await statusResp.json()) as Partial<StatusResponseBody>;
    if (status.status === 'running') {
      const queued = jobs.find((queuedJob) => queuedJob.sessionId === job.sessionId);
      if (queued) {
        queued.chunksDone = status.chunks_done;
        queued.chunksTotal = status.chunks_total;
      }
      notify();
      updatePersistentToast();
      continue;
    }

    if (status.status === 'awaiting_decision') {
      const parkedJob = buildAwaitingDecisionJob(job, pollTarget.jobId, status.failure);
      parkedJobs.set(job.sessionId, parkedJob);
      rememberParkedContext(job);
      jobs = jobs.filter((queuedJob) => queuedJob.sessionId !== job.sessionId);
      notify();
      updatePersistentToast();
      console.info('[extraction-queue] job parked (awaiting decision)', {
        session_id: job.sessionId,
        job_id: pollTarget.jobId,
        proposed_paid_slug: parkedJob.proposed_paid_slug,
      });
      return 'parked';
    }

    if (status.status === 'error') {
      throw new Error(
        typeof status.error === 'string' && status.error.trim() ? status.error : 'Extraction failed',
      );
    }

    if (status.status === 'done') {
      persistDoneExtraction(job, status, pollTarget.baseMeta);
      return 'done';
    }

    // unknown status → keep polling until deadline
  }
}

async function runJob(job: ExtractionJob): Promise<void> {
  let pollTarget: { jobId: string; baseMeta: ExtractionDraft['extractionMeta'] | undefined } | null = null;
  try {
    rememberParkedContext(job);
    pollTarget = await resolveJobPollingTarget(job);
    if (!pollTarget) {
      return;
    }

    const terminalState = await pollJob(job, pollTarget);
    if (job.isResume) {
      console.info('[extraction-queue] resume outcome', {
        session_id: job.sessionId,
        job_id: pollTarget.jobId,
        outcome: terminalState,
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failedSessions.set(job.sessionId, reason);
    showExtractionErrorToast(job.sessionId, reason);
    if (job.isResume) {
      console.info('[extraction-queue] resume outcome', {
        session_id: job.sessionId,
        job_id: pollTarget?.jobId ?? job.resumeJobId ?? 'unknown',
        outcome: 'error',
        reason,
      });
    }
  } finally {
    jobs = jobs.filter((queuedJob) => queuedJob.sessionId !== job.sessionId);
    isProcessing = false;
    notify();
    updatePersistentToast();
    processNext();
  }
}

function processNext(): void {
  if (!isBrowser() || isProcessing) {
    return;
  }

  const nextJob = jobs.find((job) => job.status === 'queued');
  if (!nextJob) {
    return;
  }

  nextJob.status = 'running';
  isProcessing = true;
  notify();
  updatePersistentToast();
  void runJob(nextJob);
}

export function enqueueExtraction(input: ExtractionJobInput): void {
  if (!isBrowser()) {
    return;
  }

  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return;
  }

  failedSessions.delete(sessionId);
  parkedJobs.delete(sessionId);
  rememberParkedContext({
    sessionId,
    pubkeyHex: input.pubkeyHex,
    title: input.title,
    directory: input.directory,
  });
  notify();

  if (jobs.some((job) => job.sessionId === sessionId)) {
    return;
  }

  jobs.push({
    ...input,
    sessionId,
    status: 'queued',
  });

  notify();
  updatePersistentToast();
  processNext();
}

export async function reattachParkedJobs(): Promise<void> {
  if (!isBrowser()) {
    return;
  }

  try {
    const response = await fetch('/api/extract/parked', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Parked extraction request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as ParkedExtractResponseBody;
    const parked = Array.isArray(payload.parked) ? payload.parked : [];
    let count = 0;
    for (const parkedJob of parked) {
      const normalized = normalizeParkedJob(parkedJob);
      if (!normalized) {
        continue;
      }
      parkedJobs.set(normalized.session_id, normalized);
      count += 1;
    }

    notify();
    console.info('[extraction-queue] reattached parked jobs', { count });
  } catch (error) {
    console.warn('[extraction-queue] failed to reattach parked jobs', { error });
  }
}

export async function resumeParkedJob(input: {
  job_id: string;
  sessionId: string;
  sessionModel: string;
  model: string;
}): Promise<void> {
  if (!isBrowser()) {
    return;
  }

  const sessionId = input.sessionId.trim();
  const requestedJobId = input.job_id.trim();
  const model = input.model.trim();
  const sessionModel = input.sessionModel.trim();

  if (!sessionId || !requestedJobId || !model) {
    return;
  }

  console.info('[extraction-queue] resume requested', {
    session_id: sessionId,
    job_id: requestedJobId,
    model,
  });

  const context = parkedContextForSession(sessionId);
  if (!context) {
    const reason = 'Unable to resume extraction because session context is unavailable. Re-run extraction instead.';
    console.error('[extraction-queue] resume failed (missing context)', {
      session_id: sessionId,
      job_id: requestedJobId,
      model,
    });
    showExtractionErrorToast(sessionId, reason);
    return;
  }

  try {
    const response = await fetch('/api/extract/resume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_id: requestedJobId,
        model,
        session_id: sessionId,
        session_model: sessionModel,
      }),
    });

    if (!response.ok) {
      const reason = await responseErrorMessage(
        response,
        `Extraction resume request failed with status ${response.status}`,
      );
      console.error('[extraction-queue] resume failed', {
        session_id: sessionId,
        job_id: requestedJobId,
        model,
        reason,
      });
      showExtractionErrorToast(sessionId, reason);
      return;
    }

    const resumed = (await response.json()) as Partial<EnqueueResponseBody>;
    if (typeof resumed.job_id !== 'string' || resumed.job_id.trim().length === 0) {
      const reason = 'Extraction resume response missing job id';
      console.error('[extraction-queue] resume failed', {
        session_id: sessionId,
        job_id: requestedJobId,
        model,
        reason,
      });
      showExtractionErrorToast(sessionId, reason);
      return;
    }

    parkedJobs.delete(sessionId);
    failedSessions.delete(sessionId);

    jobs = jobs.filter((job) => job.sessionId !== sessionId);
    jobs.push({
      sessionId,
      pubkeyHex: context.pubkeyHex,
      transcript: '',
      title: context.title,
      directory: context.directory,
      model,
      status: 'queued',
      resumeJobId: resumed.job_id,
      resumeExtractionMeta: resumed.extraction_meta,
      isResume: true,
    });

    notify();
    updatePersistentToast();
    processNext();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[extraction-queue] resume failed', {
      session_id: sessionId,
      job_id: requestedJobId,
      model,
      reason,
    });
    showExtractionErrorToast(sessionId, reason);
  }
}

export function getQueueSnapshot(): QueueSnapshot {
  if (!isBrowser()) {
    return EMPTY_SERVER_SNAPSHOT;
  }

  return cachedSnapshot;
}

export function getServerSnapshot() {
  return EMPTY_SERVER_SNAPSHOT;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function statusForSession(sessionId: string): 'queued' | 'running' | undefined {
  return jobs.find((job) => job.sessionId === sessionId)?.status;
}

export function useExtractionQueue() {
  return useSyncExternalStore(subscribe, getQueueSnapshot, getServerSnapshot);
}
