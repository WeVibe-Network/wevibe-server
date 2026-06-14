'use client';

import { useCallback, useMemo } from 'react';
import { type MemberOrgEntry, useOrgContext } from '@/lib/org-context';
import type { OrgRole } from '@/lib/org-role';
import { useIdentity } from '@/lib/identity-context';
import type { IdentityMetadata } from '@/lib/wevibe-auth';

export type ViewState =
  | 'INITIALIZING'
  | 'NO_IDENTITY'
  | 'IDENTITY_NO_ORG'
  | 'CONNECTED_LEADER'
  | 'CONNECTED_MODERATOR'
  | 'CONNECTED_CONTRIBUTOR'
  | 'CONNECTED_MEMBER';

export interface DashboardState {
  state: ViewState;
  loading: boolean;
  walletAddress: string | null;
  walletLinked: boolean;
  identity: IdentityMetadata | null;
  activeOrg: MemberOrgEntry | null;
  role: OrgRole | null;
  isLeader: boolean;
  canModerate: boolean;
  canContribute: boolean;
  refresh: () => void;
}

export function useDashboardState(): DashboardState {
  const { activeOrg, loading: orgsLoading } = useOrgContext();
  const {
    identity,
    walletAddress,
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

    if (!identity) {
      return 'NO_IDENTITY';
    }

    if (!activeOrg) {
      return 'IDENTITY_NO_ORG';
    }

    if (activeOrg.role === 'leader') {
      return 'CONNECTED_LEADER';
    }
    if (activeOrg.can_moderate) {
      return 'CONNECTED_MODERATOR';
    }
    if (activeOrg.can_contribute) {
      return 'CONNECTED_CONTRIBUTOR';
    }
    return 'CONNECTED_MEMBER';
  }, [activeOrg, identity, identityLoading, orgsLoading]);

  const { isLeader, canModerate, canContribute } = useMemo(() => {
    const isLeaderRole = activeOrg?.role === 'leader';

    return {
      isLeader: isLeaderRole,
      canModerate: isLeaderRole || activeOrg?.can_moderate === true,
      canContribute: isLeaderRole || activeOrg?.can_contribute === true,
    };
  }, [activeOrg]);

  return {
    state,
    loading: state === 'INITIALIZING',
    walletAddress,
    walletLinked: Boolean(walletAddress),
    identity,
    activeOrg,
    role: activeOrg?.role ?? null,
    isLeader,
    canModerate,
    canContribute,
    refresh,
  };
}
