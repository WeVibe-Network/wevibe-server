'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConnectionState, WeVibeMcpClient, getMcpClient } from '@/lib/mcp-client';
import {
  voteKeyword,
  voteSubmission,
  type SanitizationFinding,
} from '@/lib/hub-client';
import ClientTime from '@/components/ui/client-time';
import { useOrgContext } from '@/lib/org-context';
import { normalizeKeywordWeights, displayWeight } from '@/lib/keyword-weights';

type MemoryType = 'memory';

type KeywordWeight = {
  keyword: string;
  weight: number;
};

type KeywordVoteTally = {
  include: number;
  exclude: number;
};

type QueueItem = {
  submission_hash: string;
  contributor_pubkey: string;
  contributor_wallet?: string | null;
  contributor_display_name?: string | null;
  epoch_id: number;
  memory_type: MemoryType;
  stack_hint?: string[] | null;
  created_at?: string;
  plaintext?: string | null;
  decrypt_error?: string | null;
  steg_clean?: boolean;
  steg_findings?: Array<Record<string, unknown>> | null;
  sanitization_findings?: SanitizationFinding[] | null;
  preference_confidence?: number;
  extraction_result?: {
    classified?: KeywordWeight[] | null;
    suggestions?: KeywordWeight[] | null;
  } | KeywordWeight[] | null;
  suggested_keywords?: KeywordWeight[] | null;
  keyword_suggestions?: KeywordWeight[] | null;
  mod_votes?: {
    approve: number;
    flag: number;
  } | null;
  keyword_votes?: Record<string, KeywordVoteTally> | null;
};

function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.trunc(parsed);
}

function parseSuggestedKeywords(item: QueueItem): KeywordWeight[] {
  const directSuggestions = normalizeKeywordWeights(item.keyword_suggestions);
  if (directSuggestions.length > 0) {
    return directSuggestions;
  }

  const suggestedKeywords = normalizeKeywordWeights(item.suggested_keywords);
  if (suggestedKeywords.length > 0) {
    return suggestedKeywords;
  }

  const extractionResult = item.extraction_result as unknown;
  if (!extractionResult || typeof extractionResult !== 'object' || Array.isArray(extractionResult)) {
    return [];
  }

  const withSuggestions = extractionResult as { suggestions?: unknown };
  return normalizeKeywordWeights(withSuggestions.suggestions);
}

function parseModerationRecommendation(item: QueueItem): {
  approve: number;
  flag: number;
  flagHeavy: boolean;
} | null {
  if (!item.mod_votes) {
    return null;
  }

  const approve = toCount(item.mod_votes.approve);
  const flag = toCount(item.mod_votes.flag);
  if (approve + flag === 0) {
    return null;
  }

  return {
    approve,
    flag,
    flagHeavy: flag > approve,
  };
}

function parseKeywordVoteTally(item: QueueItem, keyword: string): KeywordVoteTally | null {
  const votes = item.keyword_votes;
  if (!votes) {
    return null;
  }

  const direct = votes[keyword];
  const fallback = direct ?? Object.entries(votes).find(
    ([candidate]) => candidate.toLowerCase() === keyword.toLowerCase(),
  )?.[1];

  if (!fallback) {
    return null;
  }

  return {
    include: toCount(fallback.include),
    exclude: toCount(fallback.exclude),
  };
}

export default function ModerationPage() {
  const { activeOrg } = useOrgContext();
  const orgId = activeOrg?.org_id ?? '';

  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const clientRef = useRef<WeVibeMcpClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const attachClient = useCallback(() => {
    const client = getMcpClient();
    clientRef.current = client;
    setClientState(client.state);
    unsubscribeRef.current?.();
    unsubscribeRef.current = client.addStateListener(setClientState);
  }, []);

  useEffect(() => {
    attachClient();
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [attachClient]);

  const loadQueue = useCallback(async () => {
    const client = clientRef.current;
    if (!orgId || !client || client.state !== 'connected') {
      return;
    }

    setLoading(true);

    try {
      const queue = await client.callTool<QueueItem[]>('wevibe_mod_queue', { org_id: orgId });
      const loadedQueue = queue ?? [];
      setItems(loadedQueue);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (clientState === 'connected' && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      void loadQueue();
    }
    if (clientState !== 'connected') {
      hasLoadedRef.current = false;
      setItems([]);
    }
  }, [clientState, loadQueue, orgId]);

  const voteOnSubmission = useCallback(async (hash: string, vote: 'approve' | 'flag') => {
    if (!orgId) {
      return;
    }

    const id = toast.loading(vote === 'approve' ? 'Recording approve vote…' : 'Recording flag vote…');
    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      toast.error('Connect to the dashboard MCP server in Settings before moderating.', { id });
      return;
    }

    setBusy(hash);

    try {
      const result = await voteSubmission(orgId, hash, vote);
      toast.success(
        `Recommendation recorded — ${result.approve} approve · ${result.flag} flag.`,
        { id },
      );
      await loadQueue();
    } catch (err) {
      toast.error((err as Error).message, { id });
    } finally {
      setBusy(null);
    }
  }, [loadQueue, orgId]);

  const voteOnKeyword = useCallback(async (
    hash: string,
    keyword: string,
    vote: 'include' | 'exclude',
  ) => {
    if (!orgId) {
      return;
    }

    const id = toast.loading(vote === 'include' ? 'Recording include vote…' : 'Recording exclude vote…');
    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      toast.error('Connect to the dashboard MCP server in Settings before moderating.', { id });
      return;
    }

    setBusy(hash);

    try {
      const result = await voteKeyword(orgId, hash, keyword, vote);
      toast.success(
        `“${keyword}” votes — include ${result.include} / exclude ${result.exclude}.`,
        { id },
      );
      await loadQueue();
    } catch (err) {
      toast.error((err as Error).message, { id });
    } finally {
      setBusy(null);
    }
  }, [loadQueue, orgId]);

  if (!activeOrg) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Moderation Queue</h1>
          <p className="text-sm text-wv-dim">
            Select an organization to review moderator recommendations.
          </p>
        </header>
        <div className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 text-sm text-wv-amber">
          No organization selected. Choose an org first.
        </div>
      </div>
    );
  }

  if (clientState !== 'connected') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Moderation Queue</h1>
          <p className="text-sm text-wv-dim">
            Connect to the dashboard MCP server to review pending submissions. Configure the connection under Settings.
          </p>
        </header>
        <div className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 text-sm text-wv-amber">
          <p className="font-medium">No MCP session detected ({clientState}).</p>
          <p className="mt-2">
            Open <Link href="/settings" className="font-medium text-wv-amber underline-offset-2 hover:underline">Settings</Link> and connect to your running `wevibe-mcp --dashboard` server. Once connected, return here to moderate submissions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Moderation Queue</h1>
          <p className="mt-1 text-sm text-wv-dim">
            Moderators provide advisory recommendations only. The leader finalizes outcomes in chain-submit.
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadQueue()}
          className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {loading && items.length === 0 ? (
        <p className="text-sm text-wv-dim">Loading moderation queue…</p>
      ) : null}

      {!loading && items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          No pending submissions. Fresh memories will appear here as they arrive.
        </div>
      ) : null}

      <div className="space-y-4">
        {items.map(item => (
          <article key={item.submission_hash} className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            {(() => {
              const recommendation = parseModerationRecommendation(item);
              const suggestions = parseSuggestedKeywords(item);

              return (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-wv-dim">
                        <span className="font-mono">{item.submission_hash}</span>
                        <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs font-mono text-wv-dim">Epoch {item.epoch_id}</span>
                        <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">
                          Memory
                        </span>
                        {recommendation && (
                          <span
                            className={recommendation.flagHeavy
                              ? 'rounded-full border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] px-2 py-0.5 text-xs font-medium text-wv-amber'
                              : 'rounded-full border border-[rgba(124,92,255,0.35)] bg-[rgba(124,92,255,0.12)] px-2 py-0.5 text-xs font-medium text-wv-violet'}
                          >
                            Recommendations: {recommendation.approve} approve · {recommendation.flag} flag
                          </span>
                        )}
                        {item.stack_hint?.map(tag => (
                          <span key={tag} className="rounded-full bg-[rgba(124,92,255,0.10)] px-2 py-0.5 text-xs text-wv-violet">
                            {tag}
                          </span>
                        ))}
                        {item.sanitization_findings && item.sanitization_findings.length > 0 && (
                          <span className="rounded-full bg-[rgba(255,107,107,0.12)] px-2 py-0.5 text-xs font-medium text-wv-red">
                            Content scan detected {item.sanitization_findings.length} issue(s)
                          </span>
                        )}
                        {item.preference_confidence !== undefined && item.preference_confidence > 0.8 && (
                          <span className="rounded-full bg-[rgba(255,107,107,0.18)] px-2 py-0.5 text-xs font-medium text-wv-red">
                            Likely preference ({(item.preference_confidence * 100).toFixed(0)}%)
                          </span>
                        )}
                        {item.preference_confidence !== undefined && item.preference_confidence > 0.5 && item.preference_confidence <= 0.8 && (
                          <span className="rounded-full bg-[rgba(255,178,85,0.12)] px-2 py-0.5 text-xs font-medium text-wv-amber">
                            Possible preference ({(item.preference_confidence * 100).toFixed(0)}%)
                          </span>
                        )}
                        {item.created_at && (
                          <ClientTime value={item.created_at} mode="datetime" className="font-mono" />
                        )}
                      </div>
                      <p className="text-xs text-wv-dim">
                        Contributor:{' '}
                        <span className="font-medium text-wv-text" title={item.contributor_wallet || item.contributor_pubkey}>
                          {item.contributor_display_name?.trim() || item.contributor_wallet || (item.contributor_pubkey ? `${item.contributor_pubkey.slice(0, 18)}…` : 'unknown')}
                        </span>
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => voteOnSubmission(item.submission_hash, 'approve')}
                        disabled={busy === item.submission_hash || loading}
                        className="inline-flex items-center rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-1.5 text-sm font-medium text-wv-green transition hover:bg-[rgba(54,211,153,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Vote: Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => voteOnSubmission(item.submission_hash, 'flag')}
                        disabled={busy === item.submission_hash || loading}
                        className="inline-flex items-center rounded-lg border border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.14)] px-3 py-1.5 text-sm font-medium text-wv-amber transition hover:bg-[rgba(255,178,85,0.2)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Vote: Flag against
                      </button>
                    </div>
                  </div>

                  {item.decrypt_error ? (
                    <div className="mt-4 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber">
                      Decryption failed: {item.decrypt_error}
                    </div>
                  ) : (
                    <pre className="mt-4 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3 text-sm text-wv-text">
                      {item.plaintext ?? 'No plaintext available.'}
                    </pre>
                  )}

                  {suggestions.length > 0 && (
                    <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.25)] bg-[rgba(255,107,107,0.08)] px-4 py-3">
                      <p className="text-xs font-medium text-wv-dim">Suggested keywords (advisory)</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {suggestions.map((suggestion, idx) => {
                          const tally = parseKeywordVoteTally(item, suggestion.keyword);

                          return (
                            <span
                              key={`${suggestion.keyword}-${idx}`}
                              className="inline-flex items-center rounded-full border border-[rgba(255,107,107,0.28)] bg-[rgba(255,107,107,0.12)] px-2.5 py-0.5 text-xs font-medium text-wv-red"
                            >
                              {suggestion.keyword}
                              <span className="ml-1 text-wv-dim">{(displayWeight(suggestion, false) * 100).toFixed(0)}%</span>
                              {tally && (
                                <span className="ml-2 text-[10px] font-normal text-wv-dim">
                                  include {tally.include} / exclude {tally.exclude}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => voteOnKeyword(item.submission_hash, suggestion.keyword, 'include')}
                                disabled={busy === item.submission_hash || loading}
                                className="ml-2 rounded bg-[rgba(255,255,255,0.2)] px-1.5 py-0.5 text-[10px] font-semibold text-wv-text transition hover:bg-[rgba(255,255,255,0.3)] disabled:cursor-not-allowed disabled:text-wv-dim"
                              >
                                include
                              </button>
                              <button
                                type="button"
                                onClick={() => voteOnKeyword(item.submission_hash, suggestion.keyword, 'exclude')}
                                disabled={busy === item.submission_hash || loading}
                                className="ml-1 rounded bg-[rgba(255,255,255,0.2)] px-1.5 py-0.5 text-[10px] font-semibold text-wv-text transition hover:bg-[rgba(255,255,255,0.3)] disabled:cursor-not-allowed disabled:text-wv-dim"
                              >
                                exclude
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {item.steg_clean === false && (item.steg_findings?.length ?? 0) > 0 && (
                    <div className="mt-4 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-4 py-3 text-sm text-wv-amber">
                      <p className="font-semibold">Steganography warning</p>
                      <ul className="mt-2 space-y-1">
                        {item.steg_findings!.map((finding, idx) => (
                          <li key={idx} className="font-mono text-xs text-wv-amber">
                            {JSON.stringify(finding)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              );
            })()}
          </article>
        ))}
      </div>

    </div>
  );
}
