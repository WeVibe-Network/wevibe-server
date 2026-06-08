'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import ClientTime from '@/components/ui/client-time';
import { ConnectionState, WeVibeMcpClient, getMcpClient } from '@/lib/mcp-client';

type HistoryItem = {
  submission_hash: string;
  memory_type: string;
  epoch_id: number;
  decision: 'approved' | 'denied';
  status: string;
  moderator_pubkey: string | null;
  decided_at: string;
  denial_reason: string | null;
};

function truncateValue(value: string | null, keep = 16): string {
  if (!value) {
    return '—';
  }

  if (value.length <= keep) {
    return value;
  }

  return `${value.slice(0, keep)}…`;
}

export default function ModerationHistoryPage() {
  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

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

  const loadHistory = useCallback(async () => {
    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      return;
    }

    setLoading(true);
    try {
      const loadedItems = await client.callTool<HistoryItem[]>('wevibe_mod_history');
      setItems(loadedItems ?? []);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (clientState === 'connected' && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      void loadHistory();
    }

    if (clientState !== 'connected') {
      hasLoadedRef.current = false;
    }
  }, [clientState, loadHistory]);

  if (clientState !== 'connected') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Moderation history</h1>
          <p className="text-sm text-wv-dim">Decisions from the last 24 hours.</p>
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
          <h1 className="text-3xl font-semibold tracking-tight">Moderation history</h1>
          <p className="mt-1 text-sm text-wv-dim">Decisions from the last 24 hours.</p>
        </div>
        <button
          type="button"
          onClick={() => loadHistory()}
          className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {loading && items.length === 0 ? (
        <p className="text-sm text-wv-dim">Loading moderation history…</p>
      ) : null}

      {!loading && items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          No moderation decisions in the last 24 hours.
        </div>
      ) : null}

      <div className="space-y-4">
        {items.map(item => (
          <article
            key={`${item.submission_hash}-${item.decided_at}`}
            className="rounded-xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-3 text-xs text-wv-dim">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${item.decision === 'approved'
                      ? 'border-[rgba(54,211,153,0.4)] bg-[rgba(54,211,153,0.12)] text-wv-green'
                      : 'border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] text-wv-red'
                    }`}
                  >
                    {item.decision}
                  </span>
                  <span className="font-mono" title={item.submission_hash}>{truncateValue(item.submission_hash)}</span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs font-mono text-wv-dim">
                    {item.memory_type}
                  </span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs font-mono text-wv-dim">
                    Epoch {item.epoch_id}
                  </span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 text-xs text-wv-dim">
                    {item.status}
                  </span>
                </div>

                <p className="text-xs text-wv-dim">
                  Moderator:{' '}
                  <span className="font-medium text-wv-text" title={item.moderator_pubkey ?? undefined}>
                    {item.moderator_pubkey ? truncateValue(item.moderator_pubkey) : '—'}
                  </span>
                </p>
              </div>

              <ClientTime value={item.decided_at} mode="datetime" className="text-xs font-mono text-wv-dim" />
            </div>

            {item.decision === 'denied' && item.denial_reason ? (
              <div className="mt-4 rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
                <p className="font-medium">Denial reason</p>
                <p className="mt-1 whitespace-pre-wrap">{item.denial_reason}</p>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
