'use client';

import { useState, useEffect } from 'react';
import { connectWallet, detectWallets, type WalletConnection, type WalletProvider } from '@/lib/wallet-connect';
import { setWalletAddress, getWalletAddress } from '@/lib/wevibe-auth';
import { linkWallet } from '@/lib/hub-client';
import Button from '@/components/ui/button';
import Badge from '@/components/ui/badge';

interface WalletConnectButtonProps {
  orgID: string;
}

export function WalletConnectButton({ orgID }: WalletConnectButtonProps) {
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [availableWallets, setAvailableWallets] = useState<WalletProvider[]>([]);

  useEffect(() => {
    getWalletAddress().then(addr => {
      if (addr) {
        setConnection({ provider: 'keplr', address: addr, pubKey: new Uint8Array(), name: '' });
        setLinked(true);
      }
    });
    setAvailableWallets(detectWallets());
  }, []);

  async function handleConnect(provider: WalletProvider) {
    setLoading(true);
    setError(null);
    try {
      const conn = await connectWallet(provider);
      setConnection(conn);
      await setWalletAddress(conn.address);
      await linkWallet(orgID, conn.address);
      setLinked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  }

  function truncateAddress(addr: string): string {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  }

  if (linked && connection) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="success">Wallet</Badge>
        <span className="text-xs font-mono text-wv-dim">{truncateAddress(connection.address)}</span>
      </div>
    );
  }

  if (availableWallets.length === 0) {
    return (
      <div className="text-xs text-wv-amber">
        Install Keplr or Leap wallet to connect
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {availableWallets.map(provider => (
          <Button
            key={provider}
            variant="secondary"
            onClick={() => handleConnect(provider)}
            disabled={loading}
            className="text-xs"
          >
            {loading ? 'Connecting...' : `Connect ${provider}`}
          </Button>
        ))}
      </div>
      {error && (
        <p className="text-xs text-wv-red">{error}</p>
      )}
    </div>
  );
}
