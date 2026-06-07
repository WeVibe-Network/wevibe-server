'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  getIdentity,
  getWalletAddress,
  isUnlocked,
  lockIdentity,
  setWalletAddress as persistWalletAddress,
  type IdentityMetadata,
  unlockIdentity,
} from './wevibe-auth';
import { getActiveWalletAddress } from './wallet-connect';
import Button from '@/components/ui/button';
import Modal from '@/components/ui/modal';

interface IdentityContextValue {
  identity: IdentityMetadata | null;
  walletAddress: string | null;
  unlocked: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  unlock: () => Promise<void>;
  lock: () => void;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<IdentityMetadata | null>(null);
  const [walletAddress, setWalletAddressState] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<boolean>(() => isUnlocked());
  const [loading, setLoading] = useState(true);
  const [walletChangePending, setWalletChangePending] = useState(false);

  const mountedRef = useRef(true);
  const walletAddressRef = useRef<string | null>(null);

  useEffect(() => {
    walletAddressRef.current = walletAddress;
  }, [walletAddress]);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setLoading(true);

    try {
      const [nextIdentity, nextWalletAddress] = await Promise.all([getIdentity(), getWalletAddress()]);
      if (!mountedRef.current) {
        return;
      }

      setIdentity(nextIdentity);
      setWalletAddressState(nextWalletAddress);
      setUnlocked(isUnlocked());
    } catch {
      if (!mountedRef.current) {
        return;
      }

      setIdentity(null);
      setWalletAddressState(null);
      setUnlocked(isUnlocked());
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const unlock = useCallback(async () => {
    await unlockIdentity();
    if (!mountedRef.current) {
      return;
    }
    setUnlocked(isUnlocked());
  }, []);

  const lock = useCallback(() => {
    lockIdentity();
    if (!mountedRef.current) {
      return;
    }
    setUnlocked(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const handleKeplrKeystoreChange = () => {
      console.info('[wevibe] keplr_keystorechange event received', { stored: walletAddressRef.current });
      if (mountedRef.current) {
        setWalletChangePending(true);
      }

      void (async () => {
        try {
          const stored = walletAddressRef.current;
          const live = await getActiveWalletAddress();
          if (live && live !== stored) {
            await persistWalletAddress(live);
          }
        } catch (e) {
          console.info('[wevibe] keplr_keystorechange persist skipped', e);
        } finally {
          await refresh();
        }
      })();
    };

    window.addEventListener('keplr_keystorechange', handleKeplrKeystoreChange);
    console.info('[wevibe] keplr_keystorechange listener registered');

    return () => {
      window.removeEventListener('keplr_keystorechange', handleKeplrKeystoreChange);
    };
  }, [refresh]);

  const value = useMemo<IdentityContextValue>(() => ({
    identity,
    walletAddress,
    unlocked,
    loading,
    refresh,
    unlock,
    lock,
  }), [identity, walletAddress, unlocked, loading, refresh, unlock, lock]);

  return (
    <IdentityContext.Provider value={value}>
      {children}
      <Modal
        open={walletChangePending}
        title="Wallet address changed"
        onClose={() => setWalletChangePending(false)}
        footer={(
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setWalletChangePending(false)}
            >
              Dismiss
            </Button>
            <Button onClick={() => window.location.reload()}>Refresh</Button>
          </div>
        )}
      >
        <p>Keplr&apos;s active wallet address changed. Refresh the page to pick up the new address.</p>
      </Modal>
    </IdentityContext.Provider>
  );
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) {
    throw new Error('useIdentity must be used within IdentityProvider');
  }
  return ctx;
}
