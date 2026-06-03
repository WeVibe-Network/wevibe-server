'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Badge from '@/components/ui/badge';
import ClientTime from '@/components/ui/client-time';
import type {
  SessionSummary,
  SessionDetail,
  MemoryCandidate,
  ExtractionStatus,
} from '@/lib/session-types';
import { getIdentity } from '@/lib/wevibe-auth';
import { buildSubmitMemoryPayload, submitMemoryBatchToHub } from '@/lib/wevibe-submit';
import { useOrgContext, type MemberOrgEntry } from '@/lib/org-context';
import { getConfig } from '@/lib/config';

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

      if (data.error && (data.memories ?? []).length === 0) {
        throw new Error(data.error);
      }

      setMemories(data.memories ?? []);
      setSelected(new Set((data.memories ?? []).map((_, i) => i)));
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

    const hubUrl = getConfig().hubUrl;

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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-wv-dim">
          Extract technical memories from your coding sessions.
          Memories are processed locally — only selected memories are submitted to your org.
        </p>
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

      <div className="space-y-3">
        {sessions.map((session) => {
          const isActive = activeSessionId === session.id;

          return (
            <div key={session.id}>
              <button
                onClick={() => selectSession(session.id)}
                className={`w-full rounded-2xl border bg-wv-panel p-5 text-left shadow-wv-sm transition
                  ${isActive
                    ? 'border-[rgba(124,92,255,0.4)] ring-2 ring-[rgba(124,92,255,0.22)]'
                    : 'border-wv-line hover:border-wv-line-2'
                  }`}
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
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <ClientTime
                      value={session.time_updated}
                      mode="relative"
                      className="font-mono text-xs text-wv-faint"
                    />
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
                  <div className="space-y-1 rounded-xl border border-wv-line bg-wv-panel p-4 text-xs font-mono text-wv-dim">
                    <p><span className="font-medium text-wv-dim">Created:</span> <ClientTime value={session.time_created} mode="datetime-compact" /></p>
                    <p><span className="font-medium text-wv-dim">Updated:</span> <ClientTime value={session.time_updated} mode="datetime-compact" /></p>
                    <p><span className="font-medium text-wv-dim">Model:</span> {session.model || 'unknown'}</p>
                    <p><span className="font-medium text-wv-dim">Messages:</span> {sessionDetail?.message_count ?? session.message_count}</p>
                  </div>

                  {extractionStatus === 'idle' && sessionDetail && (
                    <button
                      onClick={extractMemories}
                      className="inline-flex items-center rounded-lg bg-wv-grad-btn px-5 py-2.5 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v"
                    >
                      Extract Memories
                    </button>
                  )}

                  {extractionStatus === 'loading-transcript' && (
                    <div className="flex items-center gap-3 py-4 text-sm text-wv-dim">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-wv-line-2 border-t-wv-violet" />
                      Loading session transcript…
                    </div>
                  )}

                  {extractionStatus === 'extracting' && (
                    <div className="rounded-xl border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.1)] p-8 text-center">
                      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-3 border-[rgba(124,92,255,0.22)] border-t-wv-violet" />
                      <p className="mt-4 text-sm font-medium text-wv-text">
                        Extracting memories…
                      </p>
                      <p className="mt-1 text-xs text-wv-violet">
                        Please wait while your session is being analyzed
                      </p>
                    </div>
                  )}

                  {extractionStatus === 'error' && extractionError && (
                    <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
                      {extractionError}
                      <button
                        onClick={() => {
                          setExtractionStatus('idle');
                          setExtractionError(null);
                        }}
                        className="ml-3 text-wv-red underline"
                      >
                        Try again
                      </button>
                    </div>
                  )}

                  {extractionStatus === 'done' && (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">
                        <span className="font-semibold">
                          Your session produced {memories.length} memory{memories.length !== 1 ? 'ies' : ''}!
                        </span>
                        <span className="ml-2 text-wv-green">
                          Select which to submit for review.
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs">
                        <button
                          onClick={selectAll}
                          className="text-wv-violet hover:text-wv-text"
                        >
                          Select All
                        </button>
                        <span className="text-wv-faint">|</span>
                        <button
                          onClick={selectNone}
                          className="text-wv-violet hover:text-wv-text"
                        >
                          Select None
                        </button>
                        <span className="ml-auto font-mono text-wv-dim">
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
                                ? 'border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.1)] ring-1 ring-[rgba(124,92,255,0.28)]'
                                : 'border-wv-line bg-wv-panel hover:border-wv-line-2'
                              }`}
                          >
                            <div className="flex items-start gap-3">
                              <button
                                onClick={() => toggleMemory(idx)}
                                className={`mt-0.5 h-5 w-5 shrink-0 rounded border-2 flex items-center justify-center transition
                                  ${isSelected
                                    ? 'border-wv-violet bg-wv-violet'
                                    : 'border-wv-line-2 bg-wv-panel'
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
								className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green"
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
                                      className="rounded-md border border-wv-line-2 bg-wv-panel-2 px-2 py-1 text-xs text-wv-text hover:border-wv-violet focus:border-wv-violet focus:outline-none"
                                    >
                                      {orgs.map(org => (
                                        <option key={org.org_id} value={org.org_id}>
                                          {org.org_name}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                  {!showOrgDropdown && currentOrgEntry && (
                                    <span className="text-xs font-mono text-wv-dim">
                                      → {currentOrgEntry.org_name}
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm font-medium text-wv-text">
                                  {memory.insight}
                                </p>

                                {memory.context && (
                                  <p className="text-xs text-wv-dim">
                                    <span className="font-mono font-medium">Context:</span> {memory.context}
                                  </p>
                                )}

                                {memory.avoid && (
                                  <p className="rounded bg-[rgba(255,178,85,0.12)] px-2 py-1 text-xs text-wv-amber">
                                    <span className="font-mono font-medium">⚠ Avoid:</span> {memory.avoid}
                                  </p>
                                )}

                                {memory.stack.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {memory.stack.map((tech) => (
                                      <span
                                        key={tech}
                                        className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs font-mono text-wv-dim"
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
                          className="inline-flex items-center rounded-lg bg-wv-grad-btn px-5 py-2.5 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {submitting ? (
                            <>
                              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[rgba(236,237,246,0.3)] border-t-wv-text" />
                              Submitting Batch…
                            </>
                          ) : (
                            `Submit ${selected.size} Memory${selected.size !== 1 ? 'ies' : ''}`
                          )}
                        </button>

                        <button
                          onClick={extractMemories}
                          className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-text shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
                        >
                          Re-extract
                        </button>
                      </div>

                      {submitProgress && (
                        <div className="font-mono text-xs text-wv-violet">
                          {submitProgress}
                        </div>
                      )}

                      {submitFindings && submitFindings.length > 0 && (
                        <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-4 py-3 text-sm">
                          <div className="mb-1 font-medium text-wv-amber">
                            Content flagged during sanitization
                          </div>
                          <div className="text-wv-amber">
                            {submitFindings.length} finding{submitFindings.length !== 1 ? 's' : ''} detected: {submitFindings.map(f => f.category).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                          </div>
                          <div className="mt-1 text-wv-amber">
                            Your submission was received. The moderator will see these findings during review.
                          </div>
                        </div>
                      )}

                      {submitResult && (
                        <div
                          className={`rounded-lg border px-4 py-3 text-sm ${
                            submitResult.includes('failed')
                              ? 'border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] text-wv-red'
                              : 'border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] text-wv-green'
                          }`}
                        >
                          {submitResult}
                        </div>
                      )}
                    </div>
                  )}

                  {extractionStatus === 'done' && memories.length === 0 && (
                    <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel p-6 text-center text-sm text-wv-dim">
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
