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

type QueueJobStatus = 'queued' | 'running';

interface ExtractionJob extends ExtractionJobInput {
  status: QueueJobStatus;
  chunksDone?: number;
  chunksTotal?: number;
}

interface QueueSnapshot {
  jobs: { sessionId: string; status: QueueJobStatus; chunksDone?: number; chunksTotal?: number }[];
  activeCount: number;
  failedSessions: { sessionId: string; reason: string }[];
}

interface EnqueueResponseBody {
  job_id: string;
  extraction_meta: ExtractionDraft['extractionMeta'];
}

interface StatusResponseBody {
  status: 'running' | 'done' | 'error';
  chunks_done: number;
  chunks_total: number;
  memories?: MemoryCandidate[];
  empty_reason?: string;
  error?: string;
}

interface ExtractErrorBody {
  error?: string;
  code?: string;
}

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_MS = 20 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMPTY_SERVER_JOBS: QueueSnapshot['jobs'] = [];
Object.freeze(EMPTY_SERVER_JOBS);

const EMPTY_SERVER_FAILED_SESSIONS: QueueSnapshot['failedSessions'] = [];
Object.freeze(EMPTY_SERVER_FAILED_SESSIONS);

const EMPTY_SERVER_SNAPSHOT = Object.freeze({
  jobs: EMPTY_SERVER_JOBS,
  activeCount: 0,
  failedSessions: EMPTY_SERVER_FAILED_SESSIONS,
}) as QueueSnapshot;

let jobs: ExtractionJob[] = [];
let failedSessions: Map<string, string> = new Map();
let isProcessing = false;
let persistentToastId: string | number | undefined;
let toastSequence = 0;

const listeners = new Set<() => void>();
let cachedSnapshot: QueueSnapshot = EMPTY_SERVER_SNAPSHOT;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
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
  cachedSnapshot = Object.freeze({
    jobs: snapshotJobs,
    activeCount: snapshotJobs.length,
    failedSessions: snapshotFailedSessions,
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
    toast.success('Extraction complete — review your memories', { id: persistentToastId });
    persistentToastId = undefined;
  }
}

async function runJob(job: ExtractionJob): Promise<void> {
  try {
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
        return;
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
    const baseMeta = enqueue.extraction_meta;

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
        statusResp = await fetch(`/api/extract/status?job_id=${encodeURIComponent(enqueue.job_id)}`, {
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
        const queued = jobs.find((j) => j.sessionId === job.sessionId);
        if (queued) {
          queued.chunksDone = status.chunks_done;
          queued.chunksTotal = status.chunks_total;
        }
        notify();
        updatePersistentToast();
        continue;
      }

      if (status.status === 'error') {
        throw new Error(
          typeof status.error === 'string' && status.error.trim() ? status.error : 'Extraction failed',
        );
      }

      if (status.status === 'done') {
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
        return;
      }

      // unknown status → keep polling until deadline
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failedSessions.set(job.sessionId, reason);
    toast.error(`Extraction failed for session ${job.sessionId}`, {
      description: reason,
      duration: 8000,
    });
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
