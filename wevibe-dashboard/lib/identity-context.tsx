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
      void (async () => {
        try {
          const storedWalletAddress = walletAddressRef.current;
          if (storedWalletAddress) {
            const activeWalletAddress = await getActiveWalletAddress();
            if (activeWalletAddress && activeWalletAddress !== storedWalletAddress) {
              await persistWalletAddress(activeWalletAddress);
            }
          }
        } finally {
          await refresh();
        }
      })();
    };

    window.addEventListener('keplr_keystorechange', handleKeplrKeystoreChange);

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
