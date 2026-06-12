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
}

type QueueJobStatus = 'queued' | 'running';

interface ExtractionJob extends ExtractionJobInput {
  status: QueueJobStatus;
}

interface QueueSnapshot {
  jobs: { sessionId: string; status: QueueJobStatus }[];
  activeCount: number;
}

interface ExtractResponseBody {
  memories: MemoryCandidate[];
  extraction_meta?: ExtractionDraft['extractionMeta'];
}

interface ExtractErrorBody {
  error?: string;
  code?: string;
}

const EMPTY_SERVER_JOBS: QueueSnapshot['jobs'] = [];
Object.freeze(EMPTY_SERVER_JOBS);

const EMPTY_SERVER_SNAPSHOT = Object.freeze({
  jobs: EMPTY_SERVER_JOBS,
  activeCount: 0,
}) as QueueSnapshot;

let jobs: ExtractionJob[] = [];
let isProcessing = false;
let persistentToastId: string | number | undefined;
let toastSequence = 0;

const listeners = new Set<() => void>();
let cachedSnapshot: QueueSnapshot = EMPTY_SERVER_SNAPSHOT;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function rebuildSnapshot(): void {
  const snapshotJobs = jobs.map(({ sessionId, status }) => ({ sessionId, status }));
  Object.freeze(snapshotJobs);
  cachedSnapshot = Object.freeze({
    jobs: snapshotJobs,
    activeCount: snapshotJobs.length,
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
    const message = `You have ${activeCount} session${activeCount === 1 ? '' : 's'} extracting…`;
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
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transcript: job.transcript,
        title: job.title,
        directory: job.directory,
        model: job.model,
      }),
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

    const payload = (await response.json()) as Partial<ExtractResponseBody>;
    if (!Array.isArray(payload.memories)) {
      throw new Error('Extraction response missing memories array');
    }

    saveDraft(job.pubkeyHex, {
      sessionId: job.sessionId,
      sessionTitle: job.title,
      sessionDirectory: job.directory,
      memories: payload.memories as MemoryCandidate[],
      extractionMeta: payload.extraction_meta,
      createdAt: Date.now(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
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

export function getQueueSnapshot(): {
  jobs: { sessionId: string; status: 'queued' | 'running' }[];
  activeCount: number;
} {
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
