'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getUnreadCount } from '@/lib/hub-client';
import { useIdentity } from '@/lib/identity-context';
import { signWithIdentity } from '@/lib/wevibe-auth';
import { hubWsUrl } from '@/lib/config';

export default function NotificationBell() {
  const [count, setCount] = useState(0);
  const router = useRouter();
  const { identity } = useIdentity();
  const identityPubkey = identity?.pubkeyHex ?? null;

  useEffect(() => {
    let ws: WebSocket | null = null;

    async function fetchCount() {
      try {
        const result = await getUnreadCount();
        setCount(result.count);
      } catch {
        // count stays stale - correct on next page load per R-ONE-PATH
      }
    }

    async function connectWS(pubkeyHex: string) {
      if (!pubkeyHex) return;

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
            setCount((prev) => prev + 1);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    if (!identityPubkey) {
      setCount(0);
      return () => {
        ws?.close();
      };
    }

    void fetchCount();
    void connectWS(identityPubkey);

    return () => {
      ws?.close();
    };
  }, [identityPubkey]);

  return (
    <button
      onClick={() => router.push('/activity')}
      className="relative rounded-md p-2 text-wv-dim transition hover:bg-wv-line hover:text-wv-text"
      aria-label="Notifications"
    >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-wv-red text-xs font-mono text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
