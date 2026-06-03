'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type MemberOrgEntry, useOrgContext } from '@/lib/org-context';
import type { OrgRole } from '@/lib/org-role';
import { getIdentity, getWalletAddress } from '@/lib/wevibe-auth';

export type ViewState =
  | 'INITIALIZING'
  | 'NO_WALLET'
  | 'CONNECTED_NO_ORG'
  | 'CONNECTED_LEADER'
  | 'CONNECTED_MODERATOR'
  | 'CONNECTED_CONTRIBUTOR'
  | 'CONNECTED_MEMBER';

export interface DashboardState {
  state: ViewState;
  loading: boolean;
  walletAddress: string | null;
  identity: Awaited<ReturnType<typeof getIdentity>>;
  activeOrg: MemberOrgEntry | null;
  role: OrgRole | null;
  refresh: () => void;
}

export function useDashboardState(): DashboardState {
  const { activeOrg, loading: orgsLoading } = useOrgContext();

  const [identityResolved, setIdentityResolved] = useState(false);
  const [identity, setIdentity] = useState<Awaited<ReturnType<typeof getIdentity>>>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadIdentityWallet = useCallback(async () => {
    setIdentityResolved(false);

    try {
      const [nextIdentity, nextWalletAddress] = await Promise.all([getIdentity(), getWalletAddress()]);
      if (!mountedRef.current) {
        return;
      }
      setIdentity(nextIdentity);
      setWalletAddress(nextWalletAddress);
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setIdentity(null);
      setWalletAddress(null);
    } finally {
      if (mountedRef.current) {
        setIdentityResolved(true);
      }
    }
  }, []);

  useEffect(() => {
    void loadIdentityWallet();
  }, [loadIdentityWallet]);

  const refresh = useCallback(() => {
    void loadIdentityWallet();
  }, [loadIdentityWallet]);

  const state = useMemo<ViewState>(() => {
    if (!identityResolved || orgsLoading) {
      return 'INITIALIZING';
    }

    if (!walletAddress) {
      return 'NO_WALLET';
    }

    if (!activeOrg) {
      return 'CONNECTED_NO_ORG';
    }

    return (`CONNECTED_${activeOrg.role.toUpperCase()}` as ViewState);
  }, [activeOrg, identityResolved, orgsLoading, walletAddress]);

  return {
    state,
    loading: state === 'INITIALIZING',
    walletAddress,
    identity,
    activeOrg,
    role: activeOrg?.role ?? null,
    refresh,
  };
}
