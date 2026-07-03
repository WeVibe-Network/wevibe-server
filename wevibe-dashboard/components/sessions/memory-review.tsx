'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PreferenceScoreCard } from '@/components/memory/preference-score-card';
import type { SanitizationFinding } from '@/lib/hub-client';
import type { MemoryCandidate } from '@/lib/session-types';
import { getConfig } from '@/lib/config';
import { deleteDraft } from '@/lib/draft-store';
import { useOrgContext } from '@/lib/org-context';
import {
  buildSubmitMemoryPayload,
  submitMemoryBatchToHub,
  type SubmitMemoryPayload,
} from '@/lib/wevibe-submit';

type MemoryDerivation = 'verbatim' | 'edited-after-extraction';
type MemorySortMode = 'original' | 'durable-first' | 'subjective-first';

const EMPTY_MEMORY_KEYWORDS: NonNullable<MemoryCandidate['keywords']> = {
  classified: [],
  suggestions: [],
};

interface ExtractionHashPayload {
  implement: string;
  context: string;
  dnd: string | null;
  stack: string[];
}

export interface MemoryReviewProps {
  sessionId: string;
  sessionTitle?: string;
  sessionDirectory?: string;
  memories: MemoryCandidate[];
  extractionMeta?: {
    provider?: string;
    model?: string;
    session_model?: string;
    is_local?: boolean;
    source?: string;
    preset_id?: string | null;
    num_ctx?: number;
    prompt_fingerprint?: string;
  } | null;
  pubkeyHex: string;
  onSubmitted?: () => void;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sortedExtractionHashPayload(
  payload: ExtractionHashPayload,
): Record<string, string | string[] | null> {
  const sortedPayload: Record<string, string | string[] | null> = {};
  for (const key of Object.keys(payload).sort()) {
    sortedPayload[key] = payload[key as keyof ExtractionHashPayload];
  }
  return sortedPayload;
}

async function computeExtractionHash(payload: ExtractionHashPayload): Promise<string> {
  const canonicalPayload = sortedExtractionHashPayload(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalPayload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(digest);
}

async function deriveMemorySubmissionAttestation(memory: MemoryCandidate): Promise<MemoryDerivation> {
  const extractedHash = memory.extraction_hash.trim().toLowerCase();
  const recomputedHash = await computeExtractionHash({
    implement: memory.implement,
    context: memory.context,
    dnd: memory.dnd,
    stack: memory.stack,
  });
  return recomputedHash === extractedHash ? 'verbatim' : 'edited-after-extraction';
}

function extractedWithLabel(meta: MemoryReviewProps['extractionMeta']): string {
  const provider = typeof meta?.provider === 'string' ? meta.provider.trim() : '';
  const model = typeof meta?.model === 'string' ? meta.model.trim() : '';

  if (provider.length > 0 && model.length > 0) {
    return `${provider} · ${model}`;
  }

  if (provider.length > 0) {
    return provider;
  }

  if (model.length > 0) {
    return model;
  }

  if (typeof meta?.source === 'string' && meta.source.trim().length > 0) {
    return `source ${meta.source.trim()}`;
  }

  return 'configured provider';
}

export default function MemoryReview({
  sessionId,
  sessionTitle,
  sessionDirectory,
  memories,
  extractionMeta = null,
  pubkeyHex,
  onSubmitted,
}: MemoryReviewProps) {
  const { orgs, activeOrg } = useOrgContext();

  const [reviewMemories, setReviewMemories] = useState<MemoryCandidate[]>(memories);
  const [selected, setSelected] = useState<Set<number>>(
    new Set(memories.map((_, index) => index)),
  );
  const [memoryOrgs, setMemoryOrgs] = useState<Map<number, string>>(new Map());

  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [submitFindings, setSubmitFindings] = useState<SanitizationFinding[] | null>(null);
  const [sortMode, setSortMode] = useState<MemorySortMode>('original');

  useEffect(() => {
    setReviewMemories(memories);
    setSelected(new Set(memories.map((_, index) => index)));
    setMemoryOrgs(new Map());
  }, [memories]);

  const toggleMemory = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(reviewMemories.map((_, index) => index)));
  }, [reviewMemories]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const setMemoryOrg = useCallback((index: number, orgId: string) => {
    setMemoryOrgs((prev) => {
      const next = new Map(prev);
      next.set(index, orgId);
      return next;
    });
  }, []);

  const submitSelected = useCallback(async () => {
    if (selected.size === 0) {
      return;
    }

    const defaultOrgId = activeOrg?.org_id;
    const fallbackOrgId = orgs.length > 0 ? orgs[0].org_id : null;

    if (!defaultOrgId && !fallbackOrgId) {
      setSubmitResult('No org available. Configure your org in Settings first.');
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
      const existing = orgGroups.find((group) => group.orgId === orgId);
      if (existing) {
        existing.indices.push(idx);
      } else {
        orgGroups.push({ orgId, indices: [idx] });
      }
    }

    let submitted = 0;
    const errors: string[] = [];
    let allFindings: SanitizationFinding[] = [];
    const groupSummaries: Array<{ orgId: string; requested: number }> = [];
    const totalSelected = selected.size;
    let preparedCount = 0;
    let completedBatches = 0;

    try {
      for (const group of orgGroups) {
        const { orgId, indices } = group;
        groupSummaries.push({ orgId, requested: indices.length });

        const modEntry = orgs.find((org) => org.org_id === orgId);
        const modPubkey = modEntry?.mod_pubkey;

        if (!modPubkey) {
          const settingsResp = await fetch('/api/settings');
          if (settingsResp.ok) {
            const settingsData = (await settingsResp.json()) as { mod_pubkey?: string };
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

        const payloads: SubmitMemoryPayload[] = [];

        for (const idx of indices) {
          const memory = reviewMemories[idx];
          if (!memory) {
            continue;
          }

          const memoryText = `${memory.implement}${memory.context ? `\n\nContext: ${memory.context}` : ''}${memory.dnd ? `\n\nDon't: ${memory.dnd}` : ''}`;
          const derivation = await deriveMemorySubmissionAttestation(memory);

          const prepared = await buildSubmitMemoryPayload({
            memoryText,
            stackHint: memory.stack,
            orgId,
            epochId,
            memoryType: memory.memory_type,
            preferenceConfidence: memory.preference_confidence,
            keywords: memory.keywords ?? EMPTY_MEMORY_KEYWORDS,
            derivation,
            modPubkeyHex: modPubkey || '',
            hubUrl,
          });

          preparedCount += 1;
          setSubmitProgress(`Prepared ${preparedCount} of ${totalSelected} memories...`);

          if (prepared.status === 'ok') {
            payloads.push(prepared.payload);
          } else {
            errors.push(prepared.error ?? 'unknown error');
          }
        }

        if (payloads.length === 0) {
          completedBatches += 1;
          continue;
        }

        setSubmitProgress(`Submitting batch ${completedBatches + 1} of ${orgGroups.length}...`);
        const batchResult = await submitMemoryBatchToHub(hubUrl, orgId, payloads);
        submitted += batchResult.submitted;
        completedBatches += 1;

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

    const fullSuccess = submitted === totalSelected && errors.length === 0;
    if (fullSuccess) {
      deleteDraft(pubkeyHex, sessionId);
      onSubmitted?.();
    }

    if (orgGroups.length > 1) {
      const orgNames = groupSummaries.map((group) => {
        const entry = orgs.find((org) => org.org_id === group.orgId);
        return `${group.requested}→${entry?.org_name ?? group.orgId}`;
      }).join(', ');
      if (submitted > 0 && errors.length === 0) {
        setSubmitResult(`Submitted: ${orgNames}`);
      } else {
        setSubmitResult(`${submitted} submitted, ${errors.length} failed. ${orgNames}`);
      }
    } else if (submitted > 0 && errors.length === 0) {
      setSubmitResult(`${submitted} memory(ies) submitted for review!`);
    } else if (submitted > 0) {
      setSubmitResult(`${submitted} submitted, ${errors.length} failed: ${errors[0]}`);
    } else {
      setSubmitResult(`Submission failed: ${errors[0] ?? 'unknown error'}`);
    }
  }, [activeOrg, memoryOrgs, onSubmitted, orgs, pubkeyHex, reviewMemories, selected, sessionId]);

  const extractedWith = useMemo(() => extractedWithLabel(extractionMeta), [extractionMeta]);
  const sessionModel = typeof extractionMeta?.session_model === 'string'
    ? extractionMeta.session_model.trim()
    : '';
  const extractionModel = typeof extractionMeta?.model === 'string'
    ? extractionMeta.model.trim()
    : '';
  const showCardProvenance = extractionMeta !== null
    && (sessionModel.length > 0 || extractionModel.length > 0);

  const sortedReviewMemories = useMemo(() => {
    const indexedMemories = reviewMemories.map((memory, originalIndex) => ({ memory, originalIndex }));

    if (sortMode === 'original') {
      return indexedMemories;
    }

    const sortDirection = sortMode === 'durable-first' ? 1 : -1;

    return [...indexedMemories].sort((a, b) => {
      const confidenceDelta = a.memory.preference_confidence - b.memory.preference_confidence;
      if (confidenceDelta !== 0) {
        return confidenceDelta * sortDirection;
      }
      return a.originalIndex - b.originalIndex;
    });
  }, [reviewMemories, sortMode]);

  return (
    <div className="space-y-4">
      <div className="space-y-1 rounded-xl border border-wv-line bg-wv-panel p-4">
        <h3 className="text-sm font-medium text-wv-text">
          {sessionTitle || 'Untitled Session'}
        </h3>
        {sessionDirectory && (
          <p className="text-xs font-mono text-wv-dim">
            {sessionDirectory}
          </p>
        )}
        {extractionMeta && (
          <div className="font-mono text-xs text-wv-dim">
            Extracted with: {extractedWith}
            {extractionMeta.source ? ` · source ${extractionMeta.source}` : ''}
            {typeof extractionMeta.preset_id === 'string' && extractionMeta.preset_id.length > 0
              ? ` · preset ${extractionMeta.preset_id}`
              : ''}
            {typeof extractionMeta.num_ctx === 'number' ? ` · num_ctx ${extractionMeta.num_ctx}` : ''}
            {typeof extractionMeta.prompt_fingerprint === 'string' && extractionMeta.prompt_fingerprint.length > 0
              ? ` · prompt ${extractionMeta.prompt_fingerprint}`
              : ''}
          </div>
        )}
      </div>

      {reviewMemories.length === 0 ? (
        <div className="rounded-lg border border-wv-line bg-wv-panel px-4 py-3 text-sm text-wv-dim">
          No durable memories were found in this session. WeVibe keeps only reusable learnings
          (failures+fixes, conventions, gotchas); a routine session can legitimately yield none.
        </div>
      ) : (
        <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">
          <span className="font-semibold">
            Your session produced {reviewMemories.length} memor{reviewMemories.length !== 1 ? 'ies' : 'y'}!
          </span>
          <span className="ml-2 text-wv-green">
            Select which to submit for review.
          </span>
        </div>
      )}

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
          {selected.size} of {reviewMemories.length} selected
        </span>
      </div>

      {reviewMemories.length > 0 && (
        <div className="flex items-center justify-end">
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as MemorySortMode)}
            className="rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text focus:border-wv-violet focus:outline-none"
            aria-label="Sort memories by preference"
          >
            <option value="original">Original order</option>
            <option value="durable-first">Most durable first</option>
            <option value="subjective-first">Most subjective first</option>
          </select>
        </div>
      )}

      {sortedReviewMemories.map(({ memory, originalIndex }) => {
        const isSelected = selected.has(originalIndex);
        const currentOrgId = memoryOrgs.get(originalIndex) ?? activeOrg?.org_id ?? (orgs.length > 0 ? orgs[0].org_id : '');
        const currentOrgEntry = orgs.find((org) => org.org_id === currentOrgId);
        const showOrgDropdown = orgs.length > 1;
        return (
          <div
            key={`${memory.extraction_hash}-${originalIndex}`}
            className={`rounded-xl border p-4 transition
              ${isSelected
                ? 'border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.1)] ring-1 ring-[rgba(124,92,255,0.28)]'
                : 'border-wv-line bg-wv-panel hover:border-wv-line-2'
              }`}
          >
            <PreferenceScoreCard confidence={memory.preference_confidence} className="mb-3" />

            <div className="flex items-start gap-3">
              <button
                onClick={() => toggleMemory(originalIndex)}
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
                      onChange={(event) => {
                        event.stopPropagation();
                        setMemoryOrg(originalIndex, event.target.value);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded-md border border-wv-line-2 bg-wv-panel-2 px-2 py-1 text-xs text-wv-text hover:border-wv-violet focus:border-wv-violet focus:outline-none"
                    >
                      {orgs.map((org) => (
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

                {showCardProvenance && (
                  <p className="text-xs text-wv-dim">
                    <span className="font-mono font-medium">Session:</span> {sessionModel || 'unknown'} ·{' '}
                    <span className="font-mono font-medium">Extracted by:</span> {extractionModel || 'unknown'}
                  </p>
                )}

                <p className="text-sm font-medium text-wv-text">
                  {memory.implement}
                </p>

                {memory.context && (
                  <p className="text-xs text-wv-dim">
                    <span className="font-mono font-medium">Context:</span> {memory.context}
                  </p>
                )}

                {memory.dnd && (
                  <p className="rounded bg-[rgba(255,178,85,0.12)] px-2 py-1 text-xs text-wv-amber">
                    <span className="font-mono font-medium">⚠ Don&apos;t:</span> {memory.dnd}
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
            `Submit ${selected.size} Memor${selected.size !== 1 ? 'ies' : 'y'}`
          )}
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
            {submitFindings.length} finding{submitFindings.length !== 1 ? 's' : ''} detected: {submitFindings.map((finding) => finding.category).filter((value, index, arr) => arr.indexOf(value) === index).join(', ')}
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
  );
}
