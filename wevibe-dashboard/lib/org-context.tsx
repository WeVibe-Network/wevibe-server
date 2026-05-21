'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface MemberOrgEntry {
  org_id: string;
  org_name: string;
  role: 'leader' | 'moderator' | 'member';
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
      try {
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
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