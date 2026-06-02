'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { OrgRole } from './org-role';
import { getMemberOrgs } from './hub-client';
import { getIdentity } from './wevibe-auth';

export interface MemberOrgEntry {
  org_id: string;
  org_name: string;
  role: OrgRole;
  current_epoch: number;
  history_access_from_epoch: number;
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
}

const OrgContext = createContext<OrgContextValue | null>(null);

const STORAGE_KEY = 'wevibe_active_org_id';

export function OrgProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<MemberOrgEntry[]>([]);
  const [activeOrg, setActiveOrgState] = useState<MemberOrgEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadOrgs() {
      setLoading(true);
      try {
        const identity = await getIdentity();
        if (!identity) {
          setOrgs([]);
          setActiveOrgState(null);
          setError(null);
          return;
        }

        const memberOrgs = await getMemberOrgs(identity.pubkeyHex);
        setOrgs(memberOrgs);

        const savedOrgId = typeof window !== 'undefined'
          ? localStorage.getItem(STORAGE_KEY)
          : null;

        const nextActiveOrg = savedOrgId
          ? (memberOrgs.find((org) => org.org_id === savedOrgId) ?? memberOrgs[0] ?? null)
          : (memberOrgs[0] ?? null);

        setActiveOrgState(nextActiveOrg);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    loadOrgs();
  }, []);

  const setActiveOrg = (orgId: string) => {
    const org = orgs.find(o => o.org_id === orgId) || null;
    setActiveOrgState(org);
    if (orgId && typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, orgId);
    }
  };

  const value: OrgContextValue = {
    orgs,
    activeOrg,
    setActiveOrg,
    loading,
    error,
  };

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
