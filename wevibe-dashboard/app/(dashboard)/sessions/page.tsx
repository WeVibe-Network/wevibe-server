'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Badge from '@/components/ui/badge';
import type {
  SessionSummary,
  SessionDetail,
  MemoryCandidate,
  ExtractionStatus,
} from '@/lib/session-types';
import { getIdentity } from '@/lib/wevibe-auth';
import { buildSubmitMemoryPayload, submitMemoryBatchToHub } from '@/lib/wevibe-submit';
import { useOrgContext, type MemberOrgEntry } from '@/lib/org-context';

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [extractionStatus, setExtractionStatus] = useState<ExtractionStatus>('idle');
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryCandidate[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [memoryOrgs, setMemoryOrgs] = useState<Map<number, string>>(new Map());

  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [submitFindings, setSubmitFindings] = useState<import('@/lib/hub-client').SanitizationFinding[] | null>(null);
  const [identity, setIdentity] = useState<{ pubkeyHex: string } | null>(null);

  const { orgs, activeOrg } = useOrgContext();

  useEffect(() => {
    getIdentity().then(setIdentity);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch('/api/sessions');
        const data = (await resp.json()) as {
          sessions: SessionSummary[];
          error?: string;
        };
        setSessions(data.sessions);
        if (data.error) setLoadError(data.error);
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const selectSession = useCallback(
    async (id: string) => {
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setSessionDetail(null);
        setMemories([]);
        setSelected(new Set());
        setExtractionStatus('idle');
        setExtractionError(null);
        setSubmitResult(null);
        setSubmitProgress(null);
        return;
      }

      setActiveSessionId(id);
      setMemories([]);
      setSelected(new Set());
      setMemoryOrgs(new Map());
      setExtractionStatus('idle');
      setExtractionError(null);
      setSubmitResult(null);
      setSubmitProgress(null);

      setExtractionStatus('loading-transcript');
      try {
        const resp = await fetch(`/api/sessions/${id}/messages`);
        if (!resp.ok) throw new Error('Failed to load session');
        const detail = (await resp.json()) as SessionDetail;
        setSessionDetail(detail);
        setExtractionStatus('idle');
      } catch (err) {
        setExtractionError((err as Error).message);
        setExtractionStatus('error');
      }
    },
    [activeSessionId],
  );

  const extractMemories = useCallback(async () => {
    if (!sessionDetail) return;

    setExtractionStatus('extracting');
    setExtractionError(null);
    setMemories([]);
    setSelected(new Set());
    setMemoryOrgs(new Map());
    setSubmitResult(null);
    setSubmitProgress(null);

    try {
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: sessionDetail.transcript,
          title: sessionDetail.title,
          directory: sessionDetail.directory,
          model: sessionDetail.model,
        }),
      });

      const data = (await resp.json()) as {
        memories: MemoryCandidate[];
        error?: string;
      };

      if (data.error && data.memories.length === 0) {
        throw new Error(data.error);
      }

      setMemories(data.memories);
      setSelected(new Set(data.memories.map((_, i) => i)));
      setExtractionStatus('done');
    } catch (err) {
      setExtractionError((err as Error).message);
      setExtractionStatus('error');
    }
  }, [sessionDetail]);

  const toggleMemory = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(memories.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());

  const setMemoryOrg = (index: number, orgId: string) => {
    setMemoryOrgs(prev => {
      const next = new Map(prev);
      next.set(index, orgId);
      return next;
    });
  };

  const submitSelected = useCallback(async () => {
    if (selected.size === 0 || !sessionDetail) return;

    const defaultOrgId = activeOrg?.org_id;
    const fallbackOrgId = orgs.length > 0 ? orgs[0].org_id : null;

    if (!defaultOrgId && !fallbackOrgId) {
      setSubmitResult(
        'No org available. Configure your org in Settings first.',
      );
      return;
    }

    setSubmitting(true);
    setSubmitProgress('Preparing batch payloads...');
    setSubmitResult(null);
    setSubmitFindings(null);

    const hubUrl =
      process.env.NEXT_PUBLIC_WEVIBE_HUB_URL ?? 'http://localhost:4440';

    interface OrgGroup {
      orgId: string;
      indices: number[];
    }

    const orgGroups: OrgGroup[] = [];
    for (const idx of selected) {
      const orgId = memoryOrgs.get(idx) ?? defaultOrgId ?? fallbackOrgId!;
      const existing = orgGroups.find(g => g.orgId === orgId);
      if (existing) {
        existing.indices.push(idx);
      } else {
        orgGroups.push({ orgId, indices: [idx] });
      }
    }

    let submitted = 0;
    const errors: string[] = [];
    let allFindings: import('@/lib/hub-client').SanitizationFinding[] = [];
    const groupSummaries: Array<{ orgId: string; requested: number }> = [];
    const totalSelected = selected.size;
    let preparedCount = 0;
    let completedBatches = 0;

    try {
      for (const group of orgGroups) {
        const { orgId, indices } = group;
        groupSummaries.push({ orgId, requested: indices.length });

        const modEntry = orgs.find(o => o.org_id === orgId);
        const modPubkey = modEntry?.mod_pubkey;

        if (!modPubkey) {
          const settingsResp = await fetch('/api/settings');
          if (settingsResp.ok) {
            const settingsData = await settingsResp.json() as { mod_pubkey?: string };
            if (!settingsData.mod_pubkey) {
              errors.push(`No mod_pubkey for org ${orgId}`);
              continue;
            }
          }
        }

        const epochResp = await fetch(`${hubUrl}/v1/orgs/${orgId}`);
        if (!epochResp.ok) {
          errors.push(`Failed to fetch org ${orgId} epoch: HTTP ${epochResp.status}`);
          continue;
        }
        const epochData = (await epochResp.json()) as { current_epoch?: number };
        const epochId = epochData.current_epoch ?? 0;

        const payloads = [];

        for (const idx of indices) {
          const memory = memories[idx];
          if (!memory) continue;

          const parts = [memory.insight];
          if (memory.context) parts.push(`Context: ${memory.context}`);
          if (memory.avoid) parts.push(`Avoid: ${memory.avoid}`);
          const memoryText = parts.join('\n\n');

          const prepared = await buildSubmitMemoryPayload({
            memoryText,
            stackHint: memory.stack,
            orgId,
            epochId,
            memoryType: memory.memory_type,
            modPubkeyHex: modPubkey || '',
            hubUrl,
          });

          preparedCount++;
          setSubmitProgress(`Prepared ${preparedCount} of ${totalSelected} memories...`);

          if (prepared.status === 'ok') {
            payloads.push(prepared.payload);
          } else {
            errors.push(prepared.error ?? 'unknown error');
          }
        }

        if (payloads.length === 0) {
          completedBatches++;
          continue;
        }

        setSubmitProgress(`Submitting batch ${completedBatches + 1} of ${orgGroups.length}...`);
        const batchResult = await submitMemoryBatchToHub(hubUrl, orgId, payloads);
        submitted += batchResult.submitted;
        completedBatches++;

        for (const entry of batchResult.results) {
          if (entry.status === 'error') {
            errors.push(entry.error ?? `submission ${entry.submission_hash} failed`);
          }
          if (entry.sanitization_findings && entry.sanitization_findings.length > 0) {
            allFindings = allFindings.concat(entry.sanitization_findings);
          }
        }
      }
    } catch (err) {
      errors.push((err as Error).message);
    }

    setSubmitting(false);
    setSubmitProgress(null);

    if (allFindings.length > 0) {
      setSubmitFindings(allFindings);
    }

    if (orgGroups.length > 1) {
      const orgNames = groupSummaries.map(g => {
        const entry = orgs.find(o => o.org_id === g.orgId);
        return `${g.requested}→${entry?.org_name ?? g.orgId}`;
      }).join(', ');
      if (submitted > 0 && errors.length === 0) {
        setSubmitResult(`Submitted: ${orgNames}`);
      } else {
        setSubmitResult(`${submitted} submitted, ${errors.length} failed. ${orgNames}`);
      }
    } else if (submitted > 0 && errors.length === 0) {
      setSubmitResult(`${submitted} memory(ies) submitted for review!`);
    } else if (submitted > 0) {
      setSubmitResult(
        `${submitted} submitted, ${errors.length} failed: ${errors[0]}`,
      );
    } else {
      setSubmitResult(`Submission failed: ${errors[0] ?? 'unknown error'}`);
    }
  }, [selected, memories, sessionDetail, memoryOrgs, activeOrg, orgs]);

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  const formatRelative = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = now - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return '';
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-zinc-500">
          Extract technical memories from your coding sessions.
          Memories are processed locally — only selected memories are submitted to your org.
        </p>
      </header>

      {loadError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {loadError}
        </div>
      )}

      {!loadError && (
        <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 flex items-center gap-3">
          {identity ? (
            <>
              <span className="font-medium text-zinc-600">Signing as:</span>
              <code className="text-indigo-600">
                {identity.pubkeyHex.slice(0, 8)}...{identity.pubkeyHex.slice(-4)}
              </code>
            </>
          ) : (
            <>
              <span className="font-medium text-amber-600">No identity:</span>
              <button
                onClick={() => router.push('/login')}
                className="text-indigo-600 underline hover:text-indigo-800"
              >
                Set Up Identity
              </button>
            </>
          )}
        </div>
      )}

      {loading && (
        <div className="py-16 text-center text-sm text-zinc-400">
          Loading sessions…
        </div>
      )}

      {!loading && sessions.length === 0 && !loadError && (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-16 text-center text-sm text-zinc-500">
          No OpenCode sessions found. Start a coding session and it will appear here.
        </div>
      )}

      <div className="space-y-3">
        {sessions.map((session) => {
          const isActive = activeSessionId === session.id;

          return (
            <div key={session.id}>
              <button
                onClick={() => selectSession(session.id)}
                className={`w-full text-left rounded-2xl border bg-white/80 p-5 shadow-sm transition
                  ${isActive
                    ? 'border-indigo-300 ring-2 ring-indigo-100'
                    : 'border-zinc-200 hover:border-zinc-300'
                  }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-zinc-900 truncate">
                      {session.title || 'Untitled Session'}
                    </h3>
                    <p className="mt-1 text-xs text-zinc-500 truncate">
                      {session.directory}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-xs text-zinc-400">
                      {formatRelative(session.time_updated)}
                    </span>
                    <div className="flex gap-2">
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
                  <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 text-xs text-zinc-500 space-y-1">
                    <p><span className="font-medium text-zinc-600">Created:</span> {formatTime(session.time_created)}</p>
                    <p><span className="font-medium text-zinc-600">Updated:</span> {formatTime(session.time_updated)}</p>
                    <p><span className="font-medium text-zinc-600">Model:</span> {session.model || 'unknown'}</p>
                    <p><span className="font-medium text-zinc-600">Messages:</span> {sessionDetail?.message_count ?? session.message_count}</p>
                  </div>

                  {extractionStatus === 'idle' && sessionDetail && (
                    <button
                      onClick={extractMemories}
                      className="inline-flex items-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500"
                    >
                      Extract Memories
                    </button>
                  )}

                  {extractionStatus === 'loading-transcript' && (
                    <div className="flex items-center gap-3 py-4 text-sm text-zinc-500">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
                      Loading session transcript…
                    </div>
                  )}

                  {extractionStatus === 'extracting' && (
                    <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-8 text-center">
                      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-3 border-indigo-200 border-t-indigo-600" />
                      <p className="mt-4 text-sm font-medium text-indigo-900">
                        Extracting memories…
                      </p>
                      <p className="mt-1 text-xs text-indigo-600">
                        Please wait while your session is being analyzed
                      </p>
                    </div>
                  )}

                  {extractionStatus === 'error' && extractionError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                      {extractionError}
                      <button
                        onClick={() => {
                          setExtractionStatus('idle');
                          setExtractionError(null);
                        }}
                        className="ml-3 text-rose-900 underline"
                      >
                        Try again
                      </button>
                    </div>
                  )}

                  {extractionStatus === 'done' && (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                        <span className="font-semibold">
                          Your session produced {memories.length} memory{memories.length !== 1 ? 'ies' : ''}!
                        </span>
                        <span className="ml-2 text-emerald-600">
                          Select which to submit for review.
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs">
                        <button
                          onClick={selectAll}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          Select All
                        </button>
                        <span className="text-zinc-300">|</span>
                        <button
                          onClick={selectNone}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          Select None
                        </button>
                        <span className="ml-auto text-zinc-500">
                          {selected.size} of {memories.length} selected
                        </span>
                      </div>

                      {memories.map((memory, idx) => {
                        const isSelected = selected.has(idx);
                        const currentOrgId = memoryOrgs.get(idx) ?? activeOrg?.org_id ?? (orgs.length > 0 ? orgs[0].org_id : '');
                        const currentOrgEntry = orgs.find(o => o.org_id === currentOrgId);
                        const showOrgDropdown = orgs.length > 1;

                        return (
                          <div
                            key={idx}
                            className={`rounded-xl border p-4 transition
                              ${isSelected
                                ? 'border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200'
                                : 'border-zinc-200 bg-white hover:border-zinc-300'
                              }`}
                          >
                            <div className="flex items-start gap-3">
                              <button
                                onClick={() => toggleMemory(idx)}
                                className={`mt-0.5 h-5 w-5 shrink-0 rounded border-2 flex items-center justify-center transition
                                  ${isSelected
                                    ? 'border-indigo-600 bg-indigo-600'
                                    : 'border-zinc-300 bg-white'
                                  }`}
                              >
                                {isSelected && (
                                  <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>

                              <div className="min-w-0 flex-1 space-y-2">
                                <div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-2">
							  <span
								className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
							  >
								Memory
							  </span>
							</div>

                                  {showOrgDropdown && (
                                    <select
                                      value={currentOrgId}
                                      onChange={e => {
                                        e.stopPropagation();
                                        setMemoryOrg(idx, e.target.value);
                                      }}
                                      onClick={e => e.stopPropagation()}
                                      className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-700 hover:border-gray-300 focus:outline-none focus:border-indigo-400"
                                    >
                                      {orgs.map(org => (
                                        <option key={org.org_id} value={org.org_id}>
                                          {org.org_name}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                  {!showOrgDropdown && currentOrgEntry && (
                                    <span className="text-xs text-gray-500">
                                      → {currentOrgEntry.org_name}
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm font-medium text-zinc-900">
                                  {memory.insight}
                                </p>

                                {memory.context && (
                                  <p className="text-xs text-zinc-500">
                                    <span className="font-medium">Context:</span> {memory.context}
                                  </p>
                                )}

                                {memory.avoid && (
                                  <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                                    <span className="font-medium">⚠ Avoid:</span> {memory.avoid}
                                  </p>
                                )}

                                {memory.stack.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {memory.stack.map((tech) => (
                                      <span
                                        key={tech}
                                        className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
                                      >
                                        {tech}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      <div className="flex items-center gap-4 pt-2">
                        <button
                          onClick={submitSelected}
                          disabled={selected.size === 0 || submitting}
                          className="inline-flex items-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {submitting ? (
                            <>
                              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              Submitting Batch…
                            </>
                          ) : (
                            `Submit ${selected.size} Memory${selected.size !== 1 ? 'ies' : ''}`
                          )}
                        </button>

                        <button
                          onClick={extractMemories}
                          className="inline-flex items-center rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600"
                        >
                          Re-extract
                        </button>
                      </div>

                      {submitProgress && (
                        <div className="text-xs text-indigo-600">
                          {submitProgress}
                        </div>
                      )}

                      {submitFindings && submitFindings.length > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                          <div className="font-medium text-amber-800 mb-1">
                            Content flagged during sanitization
                          </div>
                          <div className="text-amber-700">
                            {submitFindings.length} finding{submitFindings.length !== 1 ? 's' : ''} detected: {submitFindings.map(f => f.category).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                          </div>
                          <div className="mt-1 text-amber-700">
                            Your submission was received. The moderator will see these findings during review.
                          </div>
                        </div>
                      )}

                      {submitResult && (
                        <div
                          className={`rounded-lg border px-4 py-3 text-sm ${
                            submitResult.includes('failed')
                              ? 'border-rose-200 bg-rose-50 text-rose-700'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {submitResult}
                        </div>
                      )}
                    </div>
                  )}

                  {extractionStatus === 'done' && memories.length === 0 && (
                    <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 p-6 text-center text-sm text-zinc-500">
                      No technical insights found in this session.
                      Try a session with more problem-solving or configuration work.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
