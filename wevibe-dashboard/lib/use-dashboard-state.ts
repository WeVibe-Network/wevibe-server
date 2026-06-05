'use client';

import { useCallback, useMemo } from 'react';
import { type MemberOrgEntry, useOrgContext } from '@/lib/org-context';
import type { OrgRole } from '@/lib/org-role';
import { useIdentity } from '@/lib/identity-context';
import type { IdentityMetadata } from '@/lib/wevibe-auth';

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
  identity: IdentityMetadata | null;
  activeOrg: MemberOrgEntry | null;
  role: OrgRole | null;
  refresh: () => void;
}

export function useDashboardState(): DashboardState {
  const { activeOrg, loading: orgsLoading } = useOrgContext();
  const {
    identity,
    walletAddress,
    unlocked,
    loading: identityLoading,
    refresh: refreshIdentity,
  } = useIdentity();

  const refresh = useCallback(() => {
    void refreshIdentity();
  }, [refreshIdentity]);

  const state = useMemo<ViewState>(() => {
    if (identityLoading || orgsLoading) {
      return 'INITIALIZING';
    }

    if (!walletAddress) {
      return 'NO_WALLET';
    }

    if (!activeOrg) {
      return 'CONNECTED_NO_ORG';
    }

    return (`CONNECTED_${activeOrg.role.toUpperCase()}` as ViewState);
  }, [activeOrg, identityLoading, orgsLoading, unlocked, walletAddress]);

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
