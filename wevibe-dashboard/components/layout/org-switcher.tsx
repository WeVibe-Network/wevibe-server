'use client';

import { useOrgContext } from '@/lib/org-context';
import { useState, useRef, useEffect } from 'react';

export default function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrg, loading } = useOrgContext();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (loading) {
    return <span className="h-5 w-24 animate-pulse rounded bg-wv-panel-3" />;
  }

  if (orgs.length === 0) {
    return null;
  }

  if (orgs.length === 1) {
    return (
      <span className="text-sm font-medium text-wv-text">
        {orgs[0].org_name}
      </span>
    );
  }

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case 'leader': return 'border border-[rgba(124,92,255,0.28)] bg-[rgba(124,92,255,0.10)] text-wv-violet';
      case 'moderator': return 'border border-[rgba(52,220,240,0.28)] bg-[rgba(52,220,240,0.10)] text-wv-cyan';
      case 'contributor': return 'border border-[rgba(255,178,85,0.28)] bg-[rgba(255,178,85,0.10)] text-wv-amber';
      default: return 'border border-wv-line bg-wv-panel-2 text-wv-dim';
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-wv-line bg-wv-panel px-3 py-1.5 text-sm font-medium text-wv-text transition hover:border-wv-line-2 hover:text-wv-violet"
      >
        <span>{activeOrg?.org_name || 'Select org'}</span>
        <svg className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-wv-line bg-wv-panel shadow-wv-lg">
          {orgs.map(org => (
            <button
              key={org.org_id}
              onClick={() => { setActiveOrg(org.org_id); setOpen(false); }}
              className={`w-full px-3 py-2 text-left text-sm transition hover:bg-wv-line
                ${activeOrg?.org_id === org.org_id ? 'bg-[rgba(124,92,255,0.14)] text-wv-violet' : 'text-wv-text'}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{org.org_name}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-xs ${roleBadgeColor(org.role)}`}>
                  {org.role}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
