'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConnectionState, getMcpClient } from '@/lib/mcp-client';
import { getWalletAddress } from '@/lib/wevibe-auth';
import OrgSwitcher from './org-switcher';
import NotificationBell from './notification-bell';

const connectionColor: Record<ConnectionState, string> = {
  disconnected: 'bg-zinc-400',
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-500',
  error: 'bg-rose-500',
};

const connectionLabel: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
};

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

export default function Topbar() {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [walletAddr, setWalletAddr] = useState<string | null>(null);

  useEffect(() => {
    const client = getMcpClient();
    setState(client.state);
    const unsubscribe = client.addStateListener(setState);

    getWalletAddress().then(addr => setWalletAddr(addr));

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
      <OrgSwitcher />
      <span className="ml-3 text-sm text-gray-500 border-l border-gray-200 pl-3">WeVibe</span>

      <div className="flex items-center gap-4 text-sm text-gray-500">
        {walletAddr && (
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="font-mono text-xs text-gray-600">{truncateAddress(walletAddr)}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${connectionColor[state]}`} />
          <span>{connectionLabel[state]}</span>
        </div>
        <NotificationBell />
        <Link href="/settings" className="rounded-md border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 transition hover:border-indigo-400 hover:text-indigo-600">
          Settings
        </Link>
      </div>
    </header>
  );
}
