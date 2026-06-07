'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getIdentity, signWithIdentity } from '@/lib/wevibe-auth';
import {
  Notification,
  listNotifications,
  markNotificationsRead,
  markAllNotificationsRead,
} from '@/lib/hub-client';
import ClientTime from '@/components/ui/client-time';
import { hubWsUrl } from '@/lib/config';

const PAGE_SIZE = 50;

export default function ActivityPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [identityReady, setIdentityReady] = useState(false);
  const router = useRouter();
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
    const signatureHex = await signWithIdentity(data);

    const ws = new WebSocket(hubWsUrl('/v1/notifications/ws'));
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

  const handleNotificationClick = useCallback(async (notification: Notification) => {
    if (!notification.read) {
      try {
        await markNotificationsRead([notification.id]);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n)),
        );
      } catch { /* ignore */ }
    }
    router.push(notification.route || '/activity');
  }, [router]);

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
          <p className="text-sm text-wv-dim">
            Notifications from all your organizations.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void handleMarkAllRead()}
            className="inline-flex items-center rounded-lg border border-wv-line px-4 py-2 text-sm font-medium text-wv-text shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet"
          >
            Mark all read
          </button>
        )}
      </header>

      {error && (
        <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-4 py-3 text-sm text-wv-red">
          {error}
        </div>
      )}

      {loading && notifications.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
          Loading notifications…
        </div>
      ) : null}

      {!loading && notifications.length === 0 ? (
        <div className="rounded-xl border border-dashed border-wv-line bg-wv-panel px-6 py-16 text-center text-sm text-wv-dim">
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
                onClick={() => { void handleNotificationClick(n); }}
                className={`group flex items-start gap-4 rounded-xl border bg-wv-panel p-4 text-left shadow-wv-sm transition ${
                  n.read
                    ? 'border-wv-line'
                    : 'border-[rgba(124,92,255,0.4)] hover:border-wv-violet'
                }`}
              >
                <div className="mt-1 flex-shrink-0">
                  {!n.read && (
                    <span className="block h-2 w-2 rounded-full bg-wv-violet" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.10)] px-2 py-0.5 text-xs text-wv-violet">
                      {n.org_name}
                    </span>
                  </div>
                  <p className="font-medium text-wv-text">{n.title}</p>
                  <p className="text-sm text-wv-dim">{n.body}</p>
                  <p className="text-xs font-mono text-wv-faint">
                    <ClientTime value={n.created_at} mode="relative" />
                  </p>
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
                className="inline-flex items-center rounded-lg border border-wv-line px-6 py-2 text-sm font-medium text-wv-text shadow-wv-sm transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-60"
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
