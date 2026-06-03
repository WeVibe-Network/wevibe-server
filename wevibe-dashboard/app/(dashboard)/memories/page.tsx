'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, WeVibeMcpClient, getMcpClient } from '@/lib/mcp-client';

type MemoryRecord = {
  cid: string;
  epoch_id: number;
  plaintext?: string;
  keywords?: Array<{ keyword: string; weight: number }>;
  content_flags?: string[];
  retrieval_count?: number;
  error?: string;
};

type ListResponse = {
  memories: MemoryRecord[];
  count: number;
  next_offset?: string | null;
};

type AuthorResponse = {
  status: 'authored' | 'error';
  cid?: string;
  error?: string;
  content_preview?: string;
};

export default function MemoriesPage() {
  const [clientState, setClientState] = useState<ConnectionState>('disconnected');
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<string | null>(null);

  const [authorContent, setAuthorContent] = useState('');
  const [authorTags, setAuthorTags] = useState('');
  const [authorBusy, setAuthorBusy] = useState(false);

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

  const loadMemories = useCallback(
    async (mode: 'reset' | 'append' = 'reset', offsetOverride?: string | null) => {
      const client = clientRef.current;
      if (!client || client.state !== 'connected') {
        return;
      }

      const offset = mode === 'append' ? (offsetOverride ?? nextOffset) : null;
      if (mode === 'append' && !offset) {
        return;
      }

      setLoading(true);
      setError(null);
      if (mode === 'reset') {
        setNotice(null);
      }

      try {
        const response = await client.callTool<ListResponse>('wevibe_list_memories', {
          limit: 50,
          ...(offset ? { offset } : {}),
        });

        const records = response.memories ?? [];
        setNextOffset(response.next_offset ?? null);
        setMemories(prev => (mode === 'append' ? [...prev, ...records] : records));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [nextOffset],
  );

  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (clientState === 'connected' && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      void loadMemories('reset', null);
    }
    if (clientState !== 'connected') {
      hasLoadedRef.current = false;
    }
  }, [clientState, loadMemories]);

  const handleAuthor = useCallback(async (event: FormEvent) => {
    event.preventDefault();

    const client = clientRef.current;
    if (!client || client.state !== 'connected') {
      setError('Connect to the dashboard MCP server in Settings before authoring memories.');
      return;
    }

    const content = authorContent.trim();
    if (!content) {
      setError('Write something meaningful before submitting.');
      return;
    }

    const tags = authorTags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);

    setAuthorBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await client.callTool<AuthorResponse>('wevibe_author_memory', {
        content,
        stack: tags,
      });

      if (result.status !== 'authored') {
        throw new Error(result.error ?? 'Authoring failed');
      }

      setAuthorContent('');
      setAuthorTags('');
      await loadMemories('reset', null);
      setNotice(`Authored memory ${result.cid ?? ''}`.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAuthorBusy(false);
    }
  }, [authorContent, authorTags, loadMemories]);

  if (clientState !== 'connected') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Memory Browser</h1>
          <p className="text-sm text-wv-dim">
            Connect to the dashboard MCP server to browse decrypted, approved memories.
          </p>
        </header>
        <div className="rounded-xl border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-6 text-sm text-wv-amber">
          <p className="font-medium">No MCP session detected ({clientState}).</p>
          <p className="mt-2">
            Visit <Link href="/settings" className="font-medium text-wv-amber underline-offset-2 hover:underline">Settings</Link> to connect, then return here to search approved memories.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Memory Browser</h1>
        <p className="text-sm text-wv-dim">
          Explore every approved memory with plaintext, keywords, and retrieval metadata. Author a new insight and the MCP server will encrypt, index, and publish instantly.
        </p>
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

      <section className="rounded-2xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
        <form className="space-y-4" onSubmit={handleAuthor}>
          <div>
            <label htmlFor="memory-content" className="block text-sm font-medium text-wv-text">
              Author a Memory
            </label>
            <textarea
              id="memory-content"
              value={authorContent}
              onChange={event => setAuthorContent(event.target.value)}
              rows={5}
              className="mt-2 w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
              placeholder="Capture a precise technical insight, workaround, or root cause…"
            />
          </div>
          <div>
            <label htmlFor="memory-tags" className="block text-sm font-medium text-wv-text">
              Tags (comma separated)
            </label>
            <input
              id="memory-tags"
              value={authorTags}
              onChange={event => setAuthorTags(event.target.value)}
              className="mt-2 w-full rounded-lg bg-wv-panel-2 border border-wv-line-2 px-3 py-2 text-sm text-wv-text placeholder:text-wv-faint focus:outline-none focus:border-wv-violet"
              placeholder="rust, qdrant, moderation"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={authorBusy}
              className="inline-flex items-center rounded-lg bg-wv-grad-btn px-4 py-2 text-sm font-medium text-white shadow-wv-sm transition hover:shadow-glow-v disabled:cursor-not-allowed disabled:opacity-60"
            >
              {authorBusy ? 'Publishing…' : 'Publish Memory'}
            </button>
            <button
              type="button"
              onClick={() => loadMemories('reset', null)}
              disabled={loading}
              className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </form>
      </section>

        <section className="space-y-4">
          {memories.map(memory => (
          <article key={memory.cid} className="rounded-2xl border border-wv-line bg-wv-panel p-6 shadow-wv-sm">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold font-mono text-wv-text">{memory.cid}</h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-wv-dim">
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 font-mono">Epoch {memory.epoch_id}</span>
                  <span className="rounded-full bg-wv-panel-2 px-2 py-0.5 font-mono">Retrievals {memory.retrieval_count ?? 0}</span>
                  {(memory.content_flags ?? []).map(flag => (
                    <span key={flag} className="rounded-full bg-[rgba(255,107,107,0.12)] px-2 py-0.5 text-wv-red">
                      {flag}
                    </span>
                  ))}
                </div>
              </div>
            </header>

            {memory.error ? (
              <div className="mt-4 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-4 py-3 text-sm text-wv-amber">
                {memory.error}
              </div>
            ) : (
              <pre className="mt-4 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-wv-line bg-wv-panel-2 px-4 py-3 text-sm text-wv-text">
                {memory.plaintext ?? ''}
              </pre>
            )}

            <footer className="mt-4 flex flex-wrap items-center gap-2">
              {(memory.keywords ?? []).map(keyword => (
                <span key={keyword.keyword} className="rounded-full bg-[rgba(124,92,255,0.10)] px-2 py-0.5 text-xs font-mono text-wv-violet">
                  {keyword.keyword}
                  {typeof keyword.weight === 'number' ? ` · ${keyword.weight.toFixed(2)}` : ''}
                </span>
              ))}
              {memory.keywords && memory.keywords.length === 0 && (
                <span className="text-xs text-wv-faint">No keywords tagged</span>
              )}
            </footer>
          </article>
        ))}

        {memories.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
            Approved memories will appear here once authored or moderated.
          </div>
        ) : null}
      </section>

      {nextOffset && (
        <button
          type="button"
          onClick={() => loadMemories('append', nextOffset)}
          disabled={loading}
          className="mx-auto inline-flex items-center rounded-lg border border-wv-line px-5 py-2 text-sm font-medium text-wv-dim shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Loading…' : 'Load More'}
        </button>
      )}
    </div>
  );
}
