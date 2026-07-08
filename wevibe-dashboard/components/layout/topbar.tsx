'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { getBalance } from '@/lib/hub-client';
import { getMcpHttpUrl } from '@/lib/config';
import { ConnectionErrorModal } from '@/components/diagnostics/connection-error-modal';
import type { ClientErrorPayload, ConnectionError, ConnectionState } from '@/lib/diagnostics-types';
import { formatVibe } from '@/lib/format';
import { useIdentity } from '@/lib/identity-context';
import { clearWalletAddress, setWalletAddress } from '@/lib/wevibe-auth';
import { connectWallet, disconnectWallet } from '@/lib/wallet-connect';
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
  const [connectionError, setConnectionError] = useState<ConnectionError | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [disconnectingWallet, setDisconnectingWallet] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);
  const walletMenuRef = useRef<HTMLDivElement | null>(null);
  const lastReportedConnectionMessageRef = useRef<string | null>(null);
  const { walletAddress, refresh } = useIdentity();

  const reportConnectionError = (err: ConnectionError) => {
    if (lastReportedConnectionMessageRef.current === err.message) {
      return;
    }

    lastReportedConnectionMessageRef.current = err.message;
    const payload = {
      kind: 'connection',
      message: err.message,
      url: err.url,
    } satisfies ClientErrorPayload;

    void fetch('/api/client-errors', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  };

  const handleConnect = async () => {
    setWalletActionError(null);
    setConnectingWallet(true);

    try {
      const conn = await connectWallet('keplr');
      await setWalletAddress(conn.address);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect wallet.';
      setWalletActionError(message);
    } finally {
      setConnectingWallet(false);
    }
  };

  const handleDisconnect = async () => {
    setWalletActionError(null);
    setDisconnectingWallet(true);

    try {
      await disconnectWallet('keplr');
      await clearWalletAddress();
      await refresh();
      setWalletMenuOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to disconnect wallet.';
      setWalletActionError(message);
    } finally {
      setDisconnectingWallet(false);
    }
  };

  useEffect(() => {
    let active = true;
    const mcpHealthUrl = `${getMcpHttpUrl().replace(/\/$/, '')}/v1/health`;

    const probe = async () => {
      let alive = false;
      try {
        const res = await fetch('/api/mcp-health', { cache: 'no-store' });
        const data = (await res.json()) as { alive?: boolean };
        alive = data.alive === true;
      } catch {
        alive = false;
      }
      if (!active) return;
      if (alive) {
        setState('connected');
        setConnectionError(null);
        lastReportedConnectionMessageRef.current = null;
      } else {
        setState('error');
        const err: ConnectionError = {
          message: `MCP server unreachable at ${mcpHealthUrl} (connection refused / timed out)`,
          url: mcpHealthUrl,
          at: new Date().toISOString(),
        };
        setConnectionError(err);
        reportConnectionError(err);
      }
    };

    setState('connecting');
    void probe();
    const intervalId = window.setInterval(() => {
      void probe();
    }, 20_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!walletAddress) {
      setBalance(null);
      return;
    }

    let active = true;
    setBalance(null);

    const refreshBalance = async () => {
      try {
        const res = await getBalance(walletAddress);
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
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) {
      setWalletMenuOpen(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (!walletMenuOpen) {
      return;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!walletMenuRef.current?.contains(event.target as Node)) {
        setWalletMenuOpen(false);
      }
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWalletMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleDocumentKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [walletMenuOpen]);

  return (
    <>
      <header className="flex h-14 items-center justify-between border-b border-wv-line bg-wv-panel px-6">
        <OrgSwitcher />
        <span className="ml-3 border-l border-wv-line pl-3 text-sm text-wv-dim">WeVibe</span>

        <div className="flex items-center gap-4 text-sm text-wv-dim">
          {walletAddress ? (
            <div ref={walletMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setWalletMenuOpen((open) => !open)}
                disabled={disconnectingWallet}
                aria-haspopup="menu"
                aria-expanded={walletMenuOpen}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 transition hover:bg-wv-panel-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
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
                <span className="font-mono text-xs text-wv-dim">{truncateAddress(walletAddress)}</span>
              </button>

              {walletMenuOpen ? (
                <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-md border border-wv-line bg-wv-panel p-3 shadow-wv-sm">
                  <p className="text-[11px] uppercase tracking-wide text-wv-dim">Connected wallet</p>
                  <p className="mt-1 break-all font-mono text-xs text-wv-dim">{walletAddress}</p>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={disconnectingWallet}
                    className="mt-3 rounded-md border border-wv-line px-2 py-1 text-xs font-medium text-wv-dim transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {disconnectingWallet ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={connectingWallet}
              className="rounded-md bg-wv-grad-btn px-3 py-1 text-xs font-medium text-white shadow-wv-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {connectingWallet ? 'Connecting…' : 'Connect Wallet'}
            </button>
          )}
          {walletActionError ? <span className="text-xs text-wv-red">{walletActionError}</span> : null}
          <button
            type="button"
            onClick={() => setDiagOpen(true)}
            aria-haspopup="dialog"
            aria-label={`Connection status: ${connectionLabel[state]} — open diagnostics`}
            className="flex items-center gap-2 rounded-md px-2 py-1 transition hover:bg-wv-panel-2"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${connectionColor[state]}`} />
            <span>{connectionLabel[state]}</span>
          </button>
          <NotificationBell />
          <Link href="/settings" className="rounded-md border border-wv-line px-3 py-1 text-xs font-medium text-wv-dim transition hover:border-[rgba(124,92,255,0.4)] hover:text-wv-violet">
            Settings
          </Link>
        </div>
      </header>

      <ConnectionErrorModal open={diagOpen} onClose={() => setDiagOpen(false)} connectionError={connectionError} />
    </>
  );
}
