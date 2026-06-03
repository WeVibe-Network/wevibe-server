'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getBalance } from '@/lib/hub-client';
import { ConnectionState, getMcpClient } from '@/lib/mcp-client';
import { formatVibe } from '@/lib/format';
import { getWalletAddress } from '@/lib/wevibe-auth';
import OrgSwitcher from './org-switcher';
import NotificationBell from './notification-bell';

const connectionColor: Record<ConnectionState, string> = {
  disconnected: 'bg-wv-panel-3',
  connecting: 'bg-wv-amber animate-pulse',
  connected: 'bg-wv-green',
  error: 'bg-wv-red',
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
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    const client = getMcpClient();
    setState(client.state);
    const unsubscribe = client.addStateListener(setState);

    getWalletAddress().then(addr => setWalletAddr(addr));

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!walletAddr) {
      setBalance(null);
      return;
    }

    let active = true;
    setBalance(null);

    const refreshBalance = async () => {
      try {
        const res = await getBalance(walletAddr);
        if (!active) return;
        setBalance(formatVibe(res.amount));
      } catch {
        if (!active) return;
        setBalance(null);
      }
    };

    void refreshBalance();
    const intervalId = window.setInterval(() => {
      void refreshBalance();
    }, 20_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [walletAddr]);

  return (
    <header className="flex h-14 items-center justify-between border-b border-wv-line bg-wv-panel px-6">
      <OrgSwitcher />
      <span className="ml-3 border-l border-wv-line pl-3 text-sm text-wv-dim">WeVibe</span>

      <div className="flex items-center gap-4 text-sm text-wv-dim">
        {walletAddr ? (
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-wv-green" />
            {balance !== null ? (
              <>
                <span className="flex items-center gap-1 font-mono text-xs">
                  <span className="text-wv-violet">{balance}</span>
                  <span className="text-wv-dim">VIBE</span>
                </span>
                <span className="text-xs text-wv-dim">·</span>
              </>
            ) : null}
            <span className="font-mono text-xs text-wv-dim">{truncateAddress(walletAddr)}</span>
          </div>
        ) : (
          <Link
            href="/login"
            className="rounded-md bg-wv-grad-btn px-3 py-1 text-xs font-medium text-white shadow-wv-sm transition hover:opacity-95"
          >
            Connect Wallet
          </Link>
        )}
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${connectionColor[state]}`} />
          <span>{connectionLabel[state]}</span>
        </div>
        <NotificationBell />
        <Link href="/settings" className="rounded-md border border-wv-line px-3 py-1 text-xs font-medium text-wv-dim transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet">
          Settings
        </Link>
      </div>
    </header>
  );
}
