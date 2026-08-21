'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { OrgRole } from './org-role';
import { getMemberOrgs } from './hub-client';
import { useIdentity } from './identity-context';

export interface MemberOrgEntry {
  org_id: string;
  org_name: string;
  role: OrgRole;
  can_contribute?: boolean;
  can_moderate?: boolean;
  egress_mode: string;
  allowed_providers: string[];
  mod_pubkey?: string;
  wallet_address?: string;
}

interface OrgContextValue {
  orgs: MemberOrgEntry[];
  activeOrg: MemberOrgEntry | null;
  setActiveOrg: (orgId: string) => void;
  loading: boolean;
  error: string | null;
  refresh: (preferredOrgId?: string) => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

const STORAGE_KEY = 'wevibe_active_org_id';

export function OrgProvider({ children }: { children: ReactNode }) {
  const { identity } = useIdentity();
  const [orgs, setOrgs] = useState<MemberOrgEntry[]>([]);
  const [activeOrg, setActiveOrgState] = useState<MemberOrgEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const identityPubkey = identity?.pubkeyHex ?? null;

  const loadOrgs = useCallback(async (preferredOrgId?: string) => {
    setLoading(true);
    try {
      if (!identityPubkey) {
        setOrgs([]);
        setActiveOrgState(null);
        setError(null);
        return;
      }

      const memberOrgs = await getMemberOrgs(identityPubkey);
      setOrgs(memberOrgs);

      const savedOrgId = typeof window !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY)
        : null;

      const preferredOrg = preferredOrgId
        ? (memberOrgs.find((org) => org.org_id === preferredOrgId) ?? null)
        : null;

      const nextActiveOrg = preferredOrg
        ?? (savedOrgId
          ? (memberOrgs.find((org) => org.org_id === savedOrgId) ?? memberOrgs[0] ?? null)
          : (memberOrgs[0] ?? null));

      if (preferredOrg && typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, preferredOrg.org_id);
      }

      setActiveOrgState(nextActiveOrg);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [identityPubkey]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  const setActiveOrg = useCallback((orgId: string) => {
    const org = orgs.find(o => o.org_id === orgId) || null;
    setActiveOrgState(org);
    if (orgId && typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, orgId);
    }
  }, [orgs]);

  const refresh = useCallback(async (preferredOrgId?: string) => {
    await loadOrgs(preferredOrgId);
  }, [loadOrgs]);

  const value = useMemo<OrgContextValue>(() => ({
    orgs,
    activeOrg,
    setActiveOrg,
    loading,
    error,
    refresh,
  }), [orgs, activeOrg, setActiveOrg, loading, error, refresh]);

  return (
    <OrgContext.Provider value={value}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrgContext(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) {
    throw new Error('useOrgContext must be used within OrgProvider');
  }
  return ctx;
}
