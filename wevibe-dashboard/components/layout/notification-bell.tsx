'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getUnreadCount } from '@/lib/hub-client';
import { getIdentity } from '@/lib/wevibe-auth';

export default function NotificationBell() {
  const [count, setCount] = useState(0);
  const router = useRouter();

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

    async function connectWS() {
      const identity = await getIdentity();
      if (!identity) return;

      const timestamp = new Date().toISOString();
      const encoder = new TextEncoder();
      const data = encoder.encode(timestamp);
      const signature = await crypto.subtle.sign('Ed25519', identity.privateKey, data);
      const signatureHex = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      ws = new WebSocket('ws://localhost:4440/v1/notifications/ws');

      ws.onopen = () => {
        ws?.send(JSON.stringify({
          type: 'auth',
          data: {
            pubkey: identity.pubkeyHex,
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

    fetchCount();
    connectWS();

    return () => {
      ws?.close();
    };
  }, []);

  return (
    <button
      onClick={() => router.push('/activity')}
      className="relative rounded-md p-2 text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
      aria-label="Notifications"
    >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      {count > 0 && (
        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
