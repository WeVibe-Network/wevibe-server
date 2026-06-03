'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, WeVibeMcpClient, getMcpClient } from '@/lib/mcp-client';
import { SanitizationFinding } from '@/lib/hub-client';
import ClientTime from '@/components/ui/client-time';

type MemoryType = 'memory';

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
  votes?: number;
  required_approvals?: number;
  voter_pubkeys?: string[];
};

type ApproveResponse = {
  status: 'approved' | 'error';
  submission_hash: string;
  memory_type?: MemoryType;
  similar_memories?: Array<{ cid: string; score?: number }>;
  error?: string;
};

type DenyResponse = {
  status: 'denied' | 'error';
  error?: string;
  reason?: string;
};

type VoteResponse = {
  status: string;
  submission_hash: string;
  votes: number;
  required_approvals: number;
  ready: boolean;
  error?: string;
};

export default function ModerationPage() {
  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<QueueItem | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [editNote, setEditNote] = useState('');

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
    if (!client || client.state !== 'connected') {
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);

    try {
      const queue = await client.callTool<QueueItem[]>('wevibe_mod_queue');
      const loadedQueue = queue ?? [];
      setItems(loadedQueue);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (clientState === 'connected' && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      void loadQueue();
    }
    if (clientState !== 'connected') {
      hasLoadedRef.current = false;
    }
  }, [clientState, loadQueue]);

  const approve = useCallback(async (hash: string) => {
    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      setError('Connect to the dashboard MCP server in Settings before moderating.');
      return;
    }

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      const result = await client.callTool<ApproveResponse>('wevibe_mod_approve', { submission_hash: hash });
      if (result.status !== 'approved') {
        throw new Error(result.error ?? 'Approval failed');
      }

      const similar = (result.similar_memories ?? [])
        .slice(0, 3)
        .map(mem => `${mem.cid}${mem.score ? ` (${mem.score.toFixed(2)})` : ''}`)
        .join(', ');

      setNotice(
        similar
          ? `Approved ${hash}. Similar memories: ${similar}`
          : `Approved ${hash}.`,
      );
      await loadQueue();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadQueue]);

  const vote = useCallback(async (hash: string) => {
    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      setError('Connect to the dashboard MCP server in Settings before moderating.');
      return;
    }

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      const result = await client.callTool<VoteResponse>('wevibe_mod_vote', { submission_hash: hash });
      if (result.status === 'error') {
        throw new Error(result.error ?? 'Vote failed');
      }

      if (result.ready) {
        setNotice(`Quorum reached for ${hash} — ${result.votes} of ${result.required_approvals} approvals recorded.`);
      } else {
        setNotice(`Voted: ${result.votes} of ${result.required_approvals} approvals for ${hash}.`);
      }
      await loadQueue();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadQueue]);

  const deny = useCallback(async (hash: string) => {
    const reason = window.prompt('Provide a denial reason:');
    if (!reason) {
      return;
    }

    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      setError('Connect to the dashboard MCP server in Settings before moderating.');
      return;
    }

    setBusy(hash);
    setError(null);
    setNotice(null);

    try {
      const result = await client.callTool<DenyResponse>('wevibe_mod_deny', {
        submission_hash: hash,
        reason,
      });

      if (result.status !== 'denied') {
        throw new Error(result.error ?? 'Denial failed');
      }

      setNotice(`Denied ${hash} — ${reason}`);
      await loadQueue();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [loadQueue]);

  const openEditFlow = useCallback((item: QueueItem) => {
    setEditTarget(item);
    setEditedContent(item.plaintext ?? '');
    setEditNote('');
    setError(null);
    setNotice(null);
  }, []);

  const saveAndApproveFallback = useCallback(async () => {
    const item = editTarget;
    if (!item) return;

    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      setError('Connect to the dashboard MCP server in Settings before moderating.');
      return;
    }

    const original = item.plaintext ?? '';
    const note = editNote.trim() || 'No moderator note provided.';
    const reason = [
      'edit_before_approval_fallback',
      `moderator_note:${note}`,
      'original_content:',
      original,
      'edited_content:',
      editedContent,
      'audit_note:encrypted submission cannot be rewritten at approval time; denied with edit note.',
    ].join('\n');

    setBusy(item.submission_hash);
    setError(null);
    setNotice(null);

    try {
      const result = await client.callTool<DenyResponse>('wevibe_mod_deny', {
        submission_hash: item.submission_hash,
        reason,
      });

      if (result.status !== 'denied') {
        throw new Error(result.error ?? 'Fallback denial failed');
      }

      setNotice(`Saved edit note and denied ${item.submission_hash}. Original and edited content preserved in denial reason for audit.`);
      setEditTarget(null);
      await loadQueue();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [editNote, editTarget, editedContent, loadQueue]);

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
            Decisions run through the MCP server — approvals re-encrypt, extract keywords, embed, and index instantly.
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

      {error && (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-4 py-3 text-sm text-wv-green">
          {notice}
        </div>
      )}

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
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-3 text-xs text-wv-dim">
                  <span className="font-mono">{item.submission_hash}</span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs font-mono text-wv-dim">Epoch {item.epoch_id}</span>
				  <span className="rounded-full bg-[rgba(54,211,153,0.12)] px-2 py-0.5 text-xs font-medium text-wv-green">
					Memory
				  </span>
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

              <div className="flex flex-col items-end gap-2">
                {(item.required_approvals ?? 1) > 1 ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-wv-dim">
                        {(item.votes ?? 0)} of {item.required_approvals} approvals
                      </span>
                      <div className="h-2 w-20 rounded-full bg-wv-line-2">
                        <div
                          className="h-2 rounded-full bg-wv-green transition-all"
                          style={{ width: `${Math.min(100, ((item.votes ?? 0) / (item.required_approvals ?? 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                    {(item.voter_pubkeys?.length ?? 0) > 0 && (
                      <p className="max-w-xs text-right text-xs font-mono text-wv-dim">
                        Voted by:{' '}
                        {item.voter_pubkeys!
                          .map((pubkey) => `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`)
                          .join(', ')}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => vote(item.submission_hash)}
                      disabled={busy === item.submission_hash || loading}
                      className="inline-flex items-center rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-1.5 text-sm font-medium text-wv-green transition hover:bg-[rgba(54,211,153,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Vote to Approve
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => approve(item.submission_hash)}
                    disabled={busy === item.submission_hash || loading}
                    className="inline-flex items-center rounded-lg border border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] px-3 py-1.5 text-sm font-medium text-wv-green transition hover:bg-[rgba(54,211,153,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Memory is good
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => deny(item.submission_hash)}
                  disabled={busy === item.submission_hash || loading}
                  className="inline-flex items-center rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-1.5 text-sm font-medium text-wv-red transition hover:bg-[rgba(255,107,107,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => openEditFlow(item)}
                  disabled={busy === item.submission_hash || loading}
                  className="inline-flex items-center rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-1.5 text-sm font-medium text-wv-amber transition hover:bg-[rgba(255,178,85,0.18)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Edit + Save & Approve
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
          </article>
        ))}
      </div>

      {editTarget && (
        <section className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-5">
          <h2 className="text-base font-semibold text-wv-amber">Edit Before Approval</h2>
          <p className="mt-1 text-xs text-wv-amber">
            Crypto pipeline constraint: approved memories are immutable encrypted submissions. Save & Approve uses deny-with-edit-note fallback and records both original and edited content for audit.
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-wv-amber">Original Content</p>
              <textarea
                value={editTarget.plaintext ?? ''}
                readOnly
                className="h-40 w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-xs text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-wv-amber">Edited Content</p>
              <textarea
                value={editedContent}
                onChange={event => setEditedContent(event.target.value)}
                className="h-40 w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-xs text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium text-wv-amber">Edit Note</label>
            <input
              type="text"
              value={editNote}
              onChange={event => setEditNote(event.target.value)}
              placeholder="Why this edit is needed"
              className="mt-1 w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
            />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => saveAndApproveFallback()}
              disabled={busy === editTarget.submission_hash}
              className="inline-flex items-center rounded-lg bg-wv-amber px-4 py-2 text-sm font-medium text-white hover:bg-[rgba(255,178,85,0.85)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === editTarget.submission_hash ? 'Saving…' : 'Save & Approve (Fallback)'}
            </button>
            <button
              type="button"
              onClick={() => setEditTarget(null)}
              className="inline-flex items-center rounded-lg border border-wv-line-2 px-4 py-2 text-sm font-medium text-wv-dim hover:bg-wv-line"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
