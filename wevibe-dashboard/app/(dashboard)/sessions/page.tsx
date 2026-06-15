'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Badge from '@/components/ui/badge';
import Button from '@/components/ui/button';
import ClientTime from '@/components/ui/client-time';
import Modal from '@/components/ui/modal';
import Spinner from '@/components/ui/spinner';
import type {
  SessionSummary,
  SessionDetail,
} from '@/lib/session-types';
import { getIdentity } from '@/lib/wevibe-auth';
import { enqueueExtraction, useExtractionQueue } from '@/lib/extraction-queue';
import {
  getHubInstanceId,
  listExtractedSessions,
  recordExtractedSession,
} from '@/lib/hub-client';
import { useOrgContext } from '@/lib/org-context';
import {
  getDraft,
  loadDrafts,
  reconcileBackendInstance,
} from '@/lib/draft-store';

type SessionSortKey = 'updated' | 'title' | 'message_count';
type SortDirection = 'asc' | 'desc';

const SESSION_SORT_STORAGE_KEY = 'wevibe.sessions.sort.v1';

// Shipping default: contributor session duplicate-extraction detection is enabled.
const SESSION_DEDUP_DETECTION_ENABLED = true;

interface LlmSettingsSnapshot {
  llm_provider: 'ollama' | 'openrouter' | 'lm_studio';
  ollama_model: string;
  openrouter_model: string;
  lmstudio_url: string;
  lmstudio_model: string;
}

interface CertifiedReadiness {
  ready: boolean;
  reason: string | null;
  provider: 'ollama' | 'openrouter' | 'lm_studio';
  model: string;
  stage: 'config' | 'live';
  checkedAt: number;
  transient: boolean;
}

const DEFAULT_LLM_SETTINGS: LlmSettingsSnapshot = {
  llm_provider: 'ollama',
  ollama_model: 'qwen2.5:14b',
  openrouter_model: '',
  lmstudio_url: 'http://127.0.0.1:1234/v1',
  lmstudio_model: '',
};

export default function SessionsPage() {
  const router = useRouter();
  const { activeOrg } = useOrgContext();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ pubkeyHex: string } | null>(null);
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [hubExtractedSessionIds, setHubExtractedSessionIds] = useState<Set<string>>(() => new Set());
  const [confirmReextractOpen, setConfirmReextractOpen] = useState(false);
  const [pendingReextractSessionId, setPendingReextractSessionId] = useState<string | null>(null);
  const [extractedDraftCount, setExtractedDraftCount] = useState(0);
  const [draftsVersion, setDraftsVersion] = useState(0);

  const [llmSettings, setLlmSettings] = useState<LlmSettingsSnapshot>(DEFAULT_LLM_SETTINGS);
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [providerReadyReason, setProviderReadyReason] = useState<string | null>(null);
  const providerReadyToastReasonRef = useRef<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SessionSortKey>('updated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const previousQueuedSessionIdsRef = useRef<Set<string>>(new Set());
  const orgId = activeOrg?.org_id ?? null;

  const queueSnapshot = useExtractionQueue();

  const queueStatusBySession = useMemo(() => {
    const lookup = new Map<string, 'queued' | 'running'>();
    for (const job of queueSnapshot.jobs) {
      lookup.set(job.sessionId, job.status);
    }
    return lookup;
  }, [queueSnapshot.jobs]);

  const failedSessionsById = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const failedSession of queueSnapshot.failedSessions) {
      lookup.set(failedSession.sessionId, failedSession.reason);
    }
    return lookup;
  }, [queueSnapshot.failedSessions]);

  const getFailureReasonForSession = useCallback(
    (sessionId: string) => failedSessionsById.get(sessionId),
    [failedSessionsById],
  );

  const openRouterModel = llmSettings.openrouter_model.trim();
  const ollamaModel = llmSettings.ollama_model.trim() || DEFAULT_LLM_SETTINGS.ollama_model;
  const lmStudioModel = llmSettings.lmstudio_model.trim();
  const useOpenRouter = llmSettings.llm_provider === 'openrouter'
    && openRouterModel.length > 0;
  const useLmStudio = llmSettings.llm_provider === 'lm_studio'
    && lmStudioModel.length > 0;
  const providerLabel = useOpenRouter
    ? `OpenRouter (cloud) · ${openRouterModel}`
    : useLmStudio
      ? `LM Studio (local) · ${lmStudioModel}`
      : `Ollama (local) · ${ollamaModel}`;
  const etaText = useOpenRouter ? '~5–20s' : '~30–90s';
  const queueCtaLabel = queueSnapshot.activeCount > 0 ? 'Add to queue' : 'Extract';
  const canEnqueueExtraction = Boolean(pubkeyHex) && providerReady === true;
  const providerNotReadyMessage = providerReadyReason?.trim().length
    ? providerReadyReason.trim()
    : 'LLM provider not configured.';

  useEffect(() => {
    let cancelled = false;

    void getIdentity().then((nextIdentity) => {
      if (cancelled) {
        return;
      }

      setIdentity(nextIdentity);
      const normalizedPubkey = nextIdentity?.pubkeyHex?.trim() ?? '';
      setPubkeyHex(normalizedPubkey.length > 0 ? normalizedPubkey : null);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function reconcileExtractedDrafts() {
      const instanceId = await getHubInstanceId();
      if (cancelled || !instanceId) {
        return;
      }

      const result = reconcileBackendInstance(instanceId);
      if (!cancelled && result.cleared) {
        setDraftsVersion((previous) => previous + 1);
      }
    }

    void reconcileExtractedDrafts();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch('/api/sessions');
        const data = (await resp.json()) as {
          sessions: SessionSummary[];
          error?: string;
        };
        setSessions(data.sessions ?? []);
        if (data.error) setLoadError(data.error);
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const activeOrgId = orgId?.trim() ?? '';

    if (!SESSION_DEDUP_DETECTION_ENABLED) {
      setHubExtractedSessionIds(new Set());
      return () => {
        cancelled = true;
      };
    }

    if (!activeOrgId || !pubkeyHex) {
      setHubExtractedSessionIds(new Set());
      return () => {
        cancelled = true;
      };
    }

    async function loadExtractedSessionIds() {
      try {
        const extractedSessions = await listExtractedSessions(activeOrgId);
        if (cancelled) {
          return;
        }

        const nextSessionIds = new Set<string>();
        for (const extractedSession of extractedSessions) {
          const normalizedSessionId = extractedSession.session_id.trim();
          if (normalizedSessionId.length > 0) {
            nextSessionIds.add(normalizedSessionId);
          }
        }

        setHubExtractedSessionIds(nextSessionIds);
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error('Failed to load extracted sessions from hub', error);
        setHubExtractedSessionIds(new Set());
      }
    }

    void loadExtractedSessionIds();

    return () => {
      cancelled = true;
    };
  }, [orgId, pubkeyHex]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const wait = (delayMs: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, delayMs);
    });

    async function loadReadiness() {
      if (inFlight) {
        return;
      }

      inFlight = true;

      try {
        const retryBackoffs = [1000, 2000];
        let readiness: CertifiedReadiness | null = null;

        for (let attempt = 0; attempt <= retryBackoffs.length; attempt += 1) {
          const response = await fetch('/api/settings/readiness');
          if (!response.ok) {
            throw new Error('Failed to load readiness settings');
          }

          readiness = (await response.json()) as CertifiedReadiness;
          if (!readiness.transient || attempt === retryBackoffs.length) {
            break;
          }

          const delay = retryBackoffs[attempt] ?? 0;
          await wait(delay);
          if (cancelled) {
            return;
          }
        }

        if (cancelled || !readiness) {
          return;
        }

        const nextModel = readiness.model.trim();

        setLlmSettings((previous) => {
          if (readiness.provider === 'openrouter') {
            return {
              llm_provider: 'openrouter',
              ollama_model: previous.ollama_model || DEFAULT_LLM_SETTINGS.ollama_model,
              openrouter_model: nextModel || previous.openrouter_model,
              lmstudio_url: previous.lmstudio_url,
              lmstudio_model: previous.lmstudio_model,
            };
          }

          if (readiness.provider === 'lm_studio') {
            return {
              llm_provider: 'lm_studio',
              ollama_model: previous.ollama_model || DEFAULT_LLM_SETTINGS.ollama_model,
              openrouter_model: previous.openrouter_model,
              lmstudio_url: previous.lmstudio_url || DEFAULT_LLM_SETTINGS.lmstudio_url,
              lmstudio_model: nextModel || previous.lmstudio_model,
            };
          }

          return {
            llm_provider: 'ollama',
            ollama_model: nextModel || DEFAULT_LLM_SETTINGS.ollama_model,
            openrouter_model: previous.openrouter_model,
            lmstudio_url: previous.lmstudio_url,
            lmstudio_model: previous.lmstudio_model,
          };
        });

        const normalizedReason = readiness.reason?.trim().length
          ? readiness.reason.trim()
          : null;

        setProviderReady(readiness.ready);
        setProviderReadyReason(normalizedReason);

        if (readiness.ready) {
          providerReadyToastReasonRef.current = null;
          return;
        }

        const toastReason = normalizedReason ?? 'Extraction model unavailable.';
        if (providerReadyToastReasonRef.current !== toastReason) {
          providerReadyToastReasonRef.current = toastReason;
          toast.error(toastReason);
        }
      } catch {
        if (cancelled) {
          return;
        }

        const fallbackReason = 'Unable to verify extraction model readiness.';
        setProviderReady(false);
        setProviderReadyReason(fallbackReason);
        if (providerReadyToastReasonRef.current !== fallbackReason) {
          providerReadyToastReasonRef.current = fallbackReason;
          toast.error(fallbackReason);
        }
      } finally {
        inFlight = false;
      }
    }

    void loadReadiness();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(SESSION_SORT_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as { key?: unknown; direction?: unknown };

      if (parsed.key === 'updated' || parsed.key === 'title' || parsed.key === 'message_count') {
        setSortKey(parsed.key);
      }
      if (parsed.direction === 'asc' || parsed.direction === 'desc') {
        setSortDirection(parsed.direction);
      }
    } catch {
      // ignore malformed saved sort state
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(
        SESSION_SORT_STORAGE_KEY,
        JSON.stringify({ key: sortKey, direction: sortDirection }),
      );
    } catch {
      // ignore local storage errors
    }
  }, [sortDirection, sortKey]);

  const loadSessionDetail = useCallback(async (id: string) => {
    setSessionDetailLoading(true);
    setExtractionError(null);

    try {
      const resp = await fetch(`/api/sessions/${id}/messages`);
      if (!resp.ok) {
        throw new Error('Failed to load session');
      }
      const detail = (await resp.json()) as SessionDetail;
      setSessionDetail(detail);
    } catch (err) {
      setSessionDetail(null);
      setExtractionError((err as Error).message);
    } finally {
      setSessionDetailLoading(false);
    }
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setSessionDetail(null);
        setSessionDetailLoading(false);
        setExtractionError(null);
        return;
      }

      setActiveSessionId(id);
      setSessionDetail(null);
      setSessionDetailLoading(true);
      setExtractionError(null);

      void loadSessionDetail(id);
    },
    [activeSessionId, loadSessionDetail],
  );

  const enqueueActiveSession = useCallback(() => {
    if (!sessionDetail || !pubkeyHex) {
      return;
    }

    enqueueExtraction({
      sessionId: sessionDetail.session_id,
      pubkeyHex,
      transcript: sessionDetail.transcript,
      title: sessionDetail.title,
      directory: sessionDetail.directory,
      model: sessionDetail.model,
    });
  }, [pubkeyHex, sessionDetail]);

  const closeReextractModal = useCallback(() => {
    setConfirmReextractOpen(false);
    setPendingReextractSessionId(null);
  }, []);

  const draftReadySessionIds = useMemo(() => {
    if (!pubkeyHex) {
      return new Set<string>();
    }

    const ready = new Set<string>();
    for (const session of sessions) {
      if (getDraft(pubkeyHex, session.id)) {
        ready.add(session.id);
      }
    }
    return ready;
  }, [sessions, pubkeyHex, queueSnapshot.activeCount, queueSnapshot.jobs, draftsVersion]);

  const extractedSessionIds = useMemo(() => {
    if (!SESSION_DEDUP_DETECTION_ENABLED) {
      return new Set<string>();
    }

    const combined = new Set(hubExtractedSessionIds);
    for (const sessionId of draftReadySessionIds) {
      combined.add(sessionId);
    }
    return combined;
  }, [draftReadySessionIds, hubExtractedSessionIds]);

  const requestActiveSessionExtraction = useCallback(() => {
    if (!sessionDetail) {
      return;
    }

    if (!SESSION_DEDUP_DETECTION_ENABLED) {
      enqueueActiveSession();
      return;
    }

    const sessionId = sessionDetail.session_id;
    if (!extractedSessionIds.has(sessionId)) {
      enqueueActiveSession();
      return;
    }

    setPendingReextractSessionId(sessionId);
    setConfirmReextractOpen(true);
  }, [enqueueActiveSession, extractedSessionIds, sessionDetail]);

  const confirmReextract = useCallback(() => {
    if (!sessionDetail || sessionDetail.session_id !== pendingReextractSessionId) {
      closeReextractModal();
      return;
    }

    closeReextractModal();
    enqueueActiveSession();
  }, [closeReextractModal, enqueueActiveSession, pendingReextractSessionId, sessionDetail]);

  const retryExtraction = useCallback(
    (session: SessionSummary) => {
      if (activeSessionId !== session.id) {
        return;
      }

      requestActiveSessionExtraction();
    },
    [activeSessionId, requestActiveSessionExtraction],
  );

  useEffect(() => {
    const queuedSessionIds = new Set<string>(queueSnapshot.jobs.map((job) => job.sessionId));
    const completedExtractedSessionIds: string[] = [];

    if (!SESSION_DEDUP_DETECTION_ENABLED) {
      previousQueuedSessionIdsRef.current = queuedSessionIds;
      return;
    }

    for (const previousSessionId of previousQueuedSessionIdsRef.current) {
      if (!queuedSessionIds.has(previousSessionId) && draftReadySessionIds.has(previousSessionId)) {
        completedExtractedSessionIds.push(previousSessionId);
      }
    }

    previousQueuedSessionIdsRef.current = queuedSessionIds;

    if (!orgId || completedExtractedSessionIds.length === 0) {
      return;
    }

    for (const sessionId of completedExtractedSessionIds) {
      void recordExtractedSession(orgId, sessionId)
        .then((record) => {
          const normalizedSessionId = record.session_id.trim();
          if (!normalizedSessionId) {
            return;
          }

          setHubExtractedSessionIds((current) => {
            if (current.has(normalizedSessionId)) {
              return current;
            }

            const next = new Set(current);
            next.add(normalizedSessionId);
            return next;
          });
        })
        .catch((error) => {
          console.error(`Failed to record extracted session ${sessionId}`, error);
        });
    }
  }, [draftReadySessionIds, orgId, queueSnapshot.jobs]);

  useEffect(() => {
    if (!pubkeyHex) {
      setExtractedDraftCount(0);
      return;
    }

    setExtractedDraftCount(Object.keys(loadDrafts(pubkeyHex)).length);
  }, [pubkeyHex, queueSnapshot.activeCount, queueSnapshot.jobs, draftsVersion]);

  const extractedSessions = useMemo(() => {
    const sorted = sessions.filter((session) => extractedSessionIds.has(session.id));
    return sorted.sort((a, b) => {
      const aUpdated = Date.parse(a.time_updated) || 0;
      const bUpdated = Date.parse(b.time_updated) || 0;
      return bUpdated - aUpdated;
    });
  }, [extractedSessionIds, sessions]);

  const visibleNonExtractedSessions = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const filtered = sessions.filter((session) => {
      if (extractedSessionIds.has(session.id)) {
        return false;
      }

      if (!query) {
        return true;
      }
      return session.title.toLowerCase().includes(query)
        || session.directory.toLowerCase().includes(query);
    });

    const directionMultiplier = sortDirection === 'asc' ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'title') {
        const aTitle = (a.title || 'Untitled Session').toLowerCase();
        const bTitle = (b.title || 'Untitled Session').toLowerCase();
        return aTitle.localeCompare(bTitle) * directionMultiplier;
      }

      if (sortKey === 'message_count') {
        const byMessages = a.message_count - b.message_count;
        if (byMessages !== 0) {
          return byMessages * directionMultiplier;
        }
      }

      const aUpdated = Date.parse(a.time_updated) || 0;
      const bUpdated = Date.parse(b.time_updated) || 0;
      return (aUpdated - bUpdated) * directionMultiplier;
    });

    return sorted;
  }, [extractedSessionIds, searchTerm, sessions, sortDirection, sortKey]);

  const renderSessionCard = (session: SessionSummary) => {
    const isActive = activeSessionId === session.id;
    const sessionQueueStatus = queueStatusBySession.get(session.id);
    const isQueued = sessionQueueStatus === 'queued';
    const isRunning = sessionQueueStatus === 'running';
    const isQueueLocked = isQueued || isRunning;
    const hasDraft = draftReadySessionIds.has(session.id);
    const isExtracted = extractedSessionIds.has(session.id);
    const activeDraft = isActive && pubkeyHex ? getDraft(pubkeyHex, session.id) : null;
    const extractedMemoryCount = activeDraft?.memories.length ?? 0;
    const failureReason = getFailureReasonForSession(session.id);
    const inactiveCardStyle = isExtracted
      ? 'border-[rgba(54,211,153,0.45)] bg-[rgba(54,211,153,0.08)] hover:border-[rgba(54,211,153,0.6)]'
      : 'border-wv-line bg-wv-panel hover:border-wv-line-2';
    const activeCardStyle = isExtracted
      ? 'border-[rgba(54,211,153,0.6)] bg-[rgba(54,211,153,0.12)] ring-2 ring-[rgba(54,211,153,0.2)]'
      : 'border-[rgba(124,92,255,0.4)] bg-wv-panel ring-2 ring-[rgba(124,92,255,0.22)]';

    return (
      <div key={session.id} className="space-y-2">
        {providerReady === false && (
          <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-4 py-3 text-sm text-wv-amber">
            Please set up your extraction model — memory extraction disabled.{' '}
            <Link href="/profile" className="underline hover:text-wv-text">Open Profile settings</Link>
            {providerReadyReason ? <span className="mt-1 block text-xs text-wv-dim">{providerReadyReason}</span> : null}
          </div>
        )}
        <button
          disabled={isQueueLocked}
          onClick={() => selectSession(session.id)}
          className={`w-full rounded-2xl border p-5 text-left shadow-wv-sm transition disabled:cursor-not-allowed
            ${isActive
              ? activeCardStyle
              : inactiveCardStyle
            }
            ${isQueueLocked ? 'opacity-60' : ''}`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-medium text-wv-text">
                {session.title || 'Untitled Session'}
              </h3>
              <p className="mt-1 truncate text-xs font-mono text-wv-dim">
                {session.directory}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <ClientTime
                value={session.time_updated}
                mode="relative"
                className="font-mono text-xs text-wv-faint"
              />
              <div className="text-[11px] font-medium">
                {isRunning && <span className="text-wv-violet">Extracting…</span>}
                {!isRunning && isQueued && <span className="text-wv-amber">Queued</span>}
                {!isRunning && !isQueued && hasDraft && <span className="text-wv-green">Draft ready</span>}
                {!isRunning && !isQueued && !hasDraft && isExtracted && <span className="text-wv-green">Extracted</span>}
              </div>
              <div className="flex gap-2">
                {isExtracted && <Badge variant="success">Extracted</Badge>}
                {session.model && (
                  <Badge>{session.model.split('/').pop()}</Badge>
                )}
                <Badge variant="default">
                  {session.message_count} msgs
                </Badge>
              </div>
            </div>
          </div>
        </button>

        {isActive && (
          <div className="mt-2 ml-4 space-y-4">
            <div className="space-y-1 rounded-xl border border-wv-line bg-wv-panel p-4 text-xs font-mono text-wv-dim">
              <p><span className="font-medium text-wv-dim">Created:</span> <ClientTime value={session.time_created} mode="datetime-compact" /></p>
              <p><span className="font-medium text-wv-dim">Updated:</span> <ClientTime value={session.time_updated} mode="datetime-compact" /></p>
              <p><span className="font-medium text-wv-dim">Model:</span> {session.model || 'unknown'}</p>
              <p><span className="font-medium text-wv-dim">Messages:</span> {sessionDetail?.message_count ?? session.message_count}</p>
            </div>

            {sessionDetailLoading && (
              <div className="flex items-center gap-3 py-4 text-sm text-wv-dim">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-wv-line-2 border-t-wv-violet" />
                Loading session transcript…
              </div>
            )}

            {!sessionDetailLoading && extractionError && (
              <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
                {extractionError}
                <button
                  onClick={() => void loadSessionDetail(session.id)}
                  className="ml-3 text-wv-red underline"
                >
                  Try again
                </button>
              </div>
            )}

            {!sessionDetailLoading && sessionDetail && isRunning && (
              <div className="rounded-xl border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.1)] p-6">
                <Spinner
                  text={`Extracting with ${providerLabel}…`}
                  className="text-sm"
                />
                <p className="mt-2 text-xs text-wv-violet">
                  {`ETA ${etaText}`}
                </p>
              </div>
            )}

            {!sessionDetailLoading && sessionDetail && !isRunning && isQueued && (
              <div className="inline-flex items-center rounded-lg border border-wv-line bg-wv-panel px-4 py-2 text-sm font-medium text-wv-amber opacity-80">
                Queued
              </div>
            )}

            {!sessionDetailLoading && sessionDetail && !isRunning && !isQueued && !hasDraft && (
              <div className="space-y-2">
                <button
                  onClick={requestActiveSessionExtraction}
                  disabled={!canEnqueueExtraction}
                  className="inline-flex items-center rounded-lg bg-wv-grad-btn px-5 py-2.5 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {queueCtaLabel}
                </button>
                <p className="text-xs text-wv-dim">
                  Extracts with {providerLabel} · {etaText}
                </p>
                {providerReady === null && (
                  <p className="text-xs text-wv-dim">
                    Checking extraction model…
                  </p>
                )}
                {!pubkeyHex && (
                  <p className="text-xs text-wv-amber">
                    Create an identity first to queue extraction.
                  </p>
                )}
                {providerReady === false && (
                  <p className="text-xs text-wv-amber">
                    {providerNotReadyMessage}{' '}
                    <Link href="/profile" className="underline hover:text-wv-text">
                      Open Profile settings
                    </Link>
                    .
                  </p>
                )}
              </div>
            )}

            {!sessionDetailLoading && sessionDetail && !isRunning && !isQueued && hasDraft && (
              <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">
                <span className="font-semibold">
                  ✓ {extractedMemoryCount} memor{extractedMemoryCount !== 1 ? 'ies' : 'y'} extracted
                </span>
                <span className="ml-2">
                  <Link href="/sessions/extracted" className="underline hover:text-wv-text">
                    Review in Extracted →
                  </Link>
                </span>
              </div>
            )}

            {!sessionDetailLoading && sessionDetail && failureReason && !isRunning && !isQueued && (
              <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-amber">
                <span>{failureReason}</span>
                <button
                  onClick={() => retryExtraction(session)}
                  disabled={!canEnqueueExtraction}
                  className="ml-3 text-wv-amber underline hover:text-wv-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Retry extraction
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-wv-dim">
          Extract technical memories from your coding sessions.
          Memories are extracted with your configured provider — only selected memories are submitted to your org.
        </p>
        <Link
          href="/sessions/extracted"
          className="inline-flex text-sm font-semibold text-wv-violet underline decoration-[rgba(124,92,255,0.6)] underline-offset-2 hover:text-wv-text"
        >
          Extracted ({extractedDraftCount}) →
        </Link>
      </header>

      {loadError && (
        <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-4 py-3 text-sm text-wv-amber">
          {loadError}
        </div>
      )}

      {!loadError && (
        <div className="flex items-center gap-3 rounded-lg border border-wv-line bg-wv-panel px-4 py-2 text-xs text-wv-dim">
          {identity ? (
            <>
              <span className="font-mono font-medium text-wv-dim">Signing as:</span>
              <code className="font-mono text-wv-violet">
                {identity.pubkeyHex.slice(0, 8)}...{identity.pubkeyHex.slice(-4)}
              </code>
            </>
          ) : (
            <>
              <span className="font-mono font-medium text-wv-amber">No identity:</span>
              <button
                onClick={() => router.push('/login')}
                className="text-wv-violet underline hover:text-wv-text"
              >
                Set Up Identity
              </button>
            </>
          )}
        </div>
      )}

      {loading && (
        <div className="py-16 text-center text-sm text-wv-faint">
          Loading sessions…
        </div>
      )}

      {!loading && sessions.length === 0 && !loadError && (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          No OpenCode sessions found. Start a coding session and it will appear here.
        </div>
      )}

      {!loading && sessions.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-wv-line bg-wv-panel p-4 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search title or directory"
            className="w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:border-wv-violet focus:outline-none sm:max-w-sm"
          />
          <div className="flex items-center gap-2">
            <select
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SessionSortKey)}
              className="rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text focus:border-wv-violet focus:outline-none"
            >
              <option value="updated">Last updated</option>
              <option value="title">Title (A→Z)</option>
              <option value="message_count">Message count</option>
            </select>
            <button
              onClick={() => setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
              className="rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
            >
              {sortDirection === 'asc' ? 'Ascending' : 'Descending'}
            </button>
          </div>
        </div>
      )}

      {!loading && sessions.length > 0 && visibleNonExtractedSessions.length === 0 && searchTerm.trim().length > 0 && (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-12 text-center text-sm text-wv-dim">
          No sessions match your search.
        </div>
      )}

      {visibleNonExtractedSessions.length > 0 && (
        <div className="space-y-3">
          {visibleNonExtractedSessions.map((session) => renderSessionCard(session))}
        </div>
      )}

      {extractedSessions.length > 0 && (
        <section className="rounded-xl border border-wv-line bg-wv-panel p-4">
          <h2 className="mb-3 text-sm font-semibold text-wv-text">
            Extracted ({extractedSessions.length})
          </h2>
          <div className="space-y-3">
            {extractedSessions.map((session) => renderSessionCard(session))}
          </div>
        </section>
      )}

      <Modal
        open={confirmReextractOpen}
        title="Re-extract this session?"
        onClose={closeReextractModal}
        footer={(
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={closeReextractModal}>
              Cancel
            </Button>
            <Button type="button" onClick={confirmReextract}>
              Re-extract anyway
            </Button>
          </div>
        )}
      >
        This session is already marked as extracted for your org. Re-extracting will process it again
        and create a fresh local draft for review.
      </Modal>
    </div>
  );
}
