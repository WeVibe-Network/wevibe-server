'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getUnreadCount,
  listNotifications,
  markNotificationsRead,
  type Notification,
} from '@/lib/hub-client';
import { reattachParkedJobs, useExtractionQueue } from '@/lib/extraction-queue';
import { useIdentity } from '@/lib/identity-context';
import { signWithIdentity } from '@/lib/wevibe-auth';
import { hubWsUrl } from '@/lib/config';

export default function NotificationBell() {
  const [hubUnreadCount, setHubUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const queueSnapshot = useExtractionQueue();
  const parkedJobs = queueSnapshot.parkedJobs;
  const { identity } = useIdentity();
  const identityPubkey = identity?.pubkeyHex ?? null;
  const totalCount = hubUnreadCount + parkedJobs.length;

  useEffect(() => {
    void reattachParkedJobs().catch((error) => {
      console.warn('[notification-bell] failed to trigger parked job reattach', { error });
    });
  }, []);

  useEffect(() => {
    if (!open || parkedJobs.length === 0) {
      return;
    }

    console.info('[notification-bell] parked jobs shown', { count: parkedJobs.length });
  }, [open, parkedJobs.length]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!bellRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleDocumentKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [open]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let active = true;

    async function fetchNotifications() {
      try {
        const result = await listNotifications({ limit: 25 });
        if (!active) return;
        setNotifications(result.notifications);
      } catch (error) {
        console.warn('[notification-bell] failed to list notifications', { error });
      }
    }

    async function fetchCount() {
      try {
        const result = await getUnreadCount();
        if (!active) return;
        setHubUnreadCount(result.count);
      } catch (error) {
        console.warn('[notification-bell] failed to load unread count', { error });
      }
    }

    async function connectWS(pubkeyHex: string) {
      if (!pubkeyHex) return;

      try {
        const timestamp = new Date().toISOString();
        const encoder = new TextEncoder();
        const data = encoder.encode(timestamp);
        const signatureHex = await signWithIdentity(data);

        ws = new WebSocket(hubWsUrl('/v1/notifications/ws'));

        ws.onopen = () => {
          ws?.send(JSON.stringify({
            type: 'auth',
            data: {
              pubkey: pubkeyHex,
              timestamp,
              signature: signatureHex,
            },
          }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'notification' || msg.event === 'new_notification') {
              if (!active) return;
              setHubUnreadCount((prev) => prev + 1);
              void fetchNotifications();
              void fetchCount();
            }
          } catch (error) {
            console.warn('[notification-bell] failed to parse notification websocket message', { error });
          }
        };

        ws.onerror = () => {
          console.warn('[notification-bell] notification websocket error');
          ws?.close();
        };
      } catch (error) {
        console.warn('[notification-bell] failed to connect notification websocket', { error });
      }
    }

    if (!identityPubkey) {
      setHubUnreadCount(0);
      setNotifications([]);
      return () => {
        active = false;
        ws?.close();
      };
    }

    void fetchCount();
    void fetchNotifications();
    void connectWS(identityPubkey);

    return () => {
      active = false;
      ws?.close();
    };
  }, [identityPubkey]);

  const handleParkedJobClick = (sessionId: string) => {
    setOpen(false);
    router.push(`/sessions?session=${encodeURIComponent(sessionId)}`);
  };

  const handleNotificationClick = (notification: Notification) => {
    setOpen(false);
    router.push(notification.route || '/activity');

    if (!notification.read) {
      setHubUnreadCount((prev) => Math.max(0, prev - 1));
    }

    setNotifications((prev) => prev.map((item) => (
      item.id === notification.id
        ? { ...item, read: true }
        : item
    )));

    void markNotificationsRead([notification.id]).catch((error) => {
      console.warn('[notification-bell] failed to mark notification as read', {
        notificationId: notification.id,
        error,
      });
    });
  };

  return (
    <div ref={bellRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative rounded-md p-2 text-wv-dim transition hover:bg-wv-line hover:text-wv-text"
        aria-label="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {totalCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-wv-red text-xs font-mono text-white">
            {totalCount > 99 ? '99+' : totalCount}
          </span>
        )}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-30 mt-2 w-96 rounded-md border border-wv-line bg-wv-panel shadow-wv-sm">
          {parkedJobs.length === 0 && notifications.length === 0 ? (
            <p className="px-4 py-3 text-sm text-wv-dim">No notifications</p>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-wv-line overflow-y-auto" role="menu" aria-label="Notifications list">
              {parkedJobs.map((job) => (
                <li key={`parked-${job.job_id}`}>
                  <button
                    type="button"
                    onClick={() => handleParkedJobClick(job.session_id)}
                    className="w-full bg-[rgba(239,68,68,0.08)] px-4 py-3 text-left transition hover:bg-[rgba(239,68,68,0.14)]"
                  >
                    <p className="text-[11px] uppercase tracking-wide text-wv-red">Extraction retry needed</p>
                    <p className="mt-1 text-sm text-wv-text">
                      {`Your session '${job.session_id}' did not extract properly — please retry.`}
                    </p>
                  </button>
                </li>
              ))}

              {notifications.map((notification) => (
                <li key={`hub-${notification.id}`}>
                  <button
                    type="button"
                    onClick={() => handleNotificationClick(notification)}
                    className="w-full px-4 py-3 text-left transition hover:bg-wv-panel-2"
                  >
                    <p className={notification.read ? 'text-sm text-wv-dim' : 'text-sm text-wv-text'}>
                      {notification.title}
                    </p>
                    <p className="mt-1 text-xs text-wv-dim">{notification.body}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
