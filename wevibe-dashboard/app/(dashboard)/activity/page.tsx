'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getIdentity } from '@/lib/wevibe-auth';
import {
  Notification,
  listNotifications,
  markNotificationsRead,
  markAllNotificationsRead,
} from '@/lib/hub-client';

const WS_URL = 'ws://localhost:4440/v1/notifications/ws';
const PAGE_SIZE = 50;

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export default function ActivityPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [identityReady, setIdentityReady] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connectWs = useCallback(async () => {
    if (!mountedRef.current) return;

    const identity = await getIdentity();
    if (!identity) return;

    const timestamp = new Date().toISOString();
    const encoder = new TextEncoder();
    const data = encoder.encode(timestamp);
    const signature = await crypto.subtle.sign('Ed25519', identity.privateKey, data);
    const signatureHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      ws.send(JSON.stringify({
        type: 'auth',
        data: {
          pubkey: identity.pubkeyHex,
          timestamp,
          signature: signatureHex,
        },
      }));
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_success') return;
        if (msg.type === 'notification') {
          setNotifications((prev) => [msg.data as Notification, ...prev]);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      wsRef.current = null;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) void connectWs();
      }, 3000);
    };
  }, []);

  const loadNotifications = useCallback(async (before?: number) => {
    if (before === undefined) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const res = await listNotifications({ limit: PAGE_SIZE, before });
      setNotifications((prev) => {
        if (before === undefined) return res.notifications;
        return [...prev, ...res.notifications];
      });
      setHasMore(res.has_more);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const loadMore = useCallback(() => {
    if (notifications.length === 0) return;
    const oldest = notifications[notifications.length - 1];
    void loadNotifications(oldest.id);
  }, [loadNotifications, notifications]);

  const handleMarkRead = useCallback(async (id: number) => {
    try {
      await markNotificationsRead([id]);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
    } catch { /* ignore */ }
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    getIdentity()
      .then((id) => { if (id) setIdentityReady(true); })
      .catch(() => setIdentityReady(false));
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    void loadNotifications();
    void connectWs();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [identityReady, loadNotifications, connectWs]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
          <p className="text-sm text-zinc-500">
            Notifications from all your organizations.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void handleMarkAllRead()}
            className="inline-flex items-center rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600"
          >
            Mark all read
          </button>
        )}
      </header>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && notifications.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-16 text-center text-sm text-zinc-500">
          Loading notifications…
        </div>
      ) : null}

      {!loading && notifications.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-16 text-center text-sm text-zinc-500">
          No activity yet. Notifications will appear here as your org processes memories.
        </div>
      ) : null}

      {notifications.length > 0 && (
        <>
          <div className="flex flex-col gap-3">
            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => { if (!n.read) void handleMarkRead(n.id); }}
                className={`group flex items-start gap-4 rounded-xl border bg-white p-4 text-left shadow-sm transition ${
                  n.read
                    ? 'border-zinc-100'
                    : 'border-indigo-200 hover:border-indigo-300'
                }`}
              >
                <div className="mt-1 flex-shrink-0">
                  {!n.read && (
                    <span className="block h-2 w-2 rounded-full bg-indigo-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                      {n.org_name}
                    </span>
                  </div>
                  <p className="font-medium text-zinc-900">{n.title}</p>
                  <p className="text-sm text-zinc-500">{n.body}</p>
                  <p className="text-xs text-zinc-400">{relativeTime(n.created_at)}</p>
                </div>
              </button>
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="inline-flex items-center rounded-lg border border-zinc-200 px-6 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
