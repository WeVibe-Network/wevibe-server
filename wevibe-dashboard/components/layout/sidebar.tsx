'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { activeSectionForPath, GENERAL_NAV, mainSectionsForState } from '@/lib/nav-config';
import { useOrgContext } from '@/lib/org-context';
import type { OrgRole } from '@/lib/org-role';
import { useDashboardState } from '@/lib/use-dashboard-state';

function isPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function rolePillClass(role: OrgRole): string {
  switch (role) {
    case 'leader':
      return 'border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.12)] text-wv-violet';
    case 'moderator':
      return 'border-[rgba(52,220,240,0.4)] bg-[rgba(52,220,240,0.12)] text-wv-cyan';
    case 'contributor':
      return 'border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] text-wv-amber';
    default:
      return 'border-wv-line-2 bg-wv-panel-2 text-wv-dim';
  }
}

export default function Sidebar() {
  const pathname = usePathname();
  const { state } = useDashboardState();
  const { activeOrg, orgs, loading } = useOrgContext();

  const sections = useMemo(() => mainSectionsForState(state), [state]);
  const activeSection = useMemo(() => activeSectionForPath(sections, pathname), [sections, pathname]);

  const showCreateOrg = !loading && orgs.length === 0;

  return (
    <aside className="flex w-56 flex-col border-r border-wv-line bg-wv-panel">
      <div className="border-b border-wv-line px-4 py-5">
        <span className="font-semibold text-wv-text">WeVibe Network</span>
      </div>

      {activeOrg ? (
        <div className="border-b border-wv-line px-3 py-3">
          <div className="rounded-xl border border-[rgba(124,92,255,0.28)] bg-wv-panel-2 p-3 shadow-[0_0_28px_rgba(124,92,255,0.16)]">
            <Link href="/my-org" className="group block">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-wv-faint">My Org</span>
              <p className="mt-1.5 truncate text-sm font-medium text-wv-text transition group-hover:text-wv-violet" title={activeOrg.org_name}>
                {activeOrg.org_name}
              </p>
            </Link>
            <span
              className={`mt-1.5 inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${rolePillClass(
                activeOrg.role,
              )}`}
            >
              {activeOrg.role}
            </span>
          </div>
        </div>
      ) : null}

      <nav className="flex-1 space-y-4 overflow-y-auto p-3">
        {sections.length > 0 ? (
          <div className="space-y-1">
            {sections.map(section => {
              const href = section.sub[0]?.href ?? '/';
              const isActive = activeSection?.key === section.key;

              return (
                <Link
                  key={section.key}
                  href={href}
                  data-testid={`nav-main-${section.key}`}
                  className={`block rounded-md px-3 py-2 text-sm transition ${
                    isActive
                      ? 'border-l-2 border-wv-violet bg-[rgba(124,92,255,0.14)] font-medium text-wv-amber'
                      : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
                  }`}
                >
                  {section.label}
                </Link>
              );
            })}
          </div>
        ) : null}

        <div className="border-t border-wv-line pt-3">
          <p className="px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-wv-dim">General</p>
          <div className="space-y-1">
            {GENERAL_NAV.map(({ href, label }) => {
              const isActive = isPathActive(pathname, href);

              return (
                <Link
                  key={href}
                  href={href}
                  data-testid={`nav-general-${href.slice(1)}`}
                  className={`block rounded-md px-3 py-2 text-sm transition ${
                    isActive
                      ? 'border-l-2 border-wv-violet bg-[rgba(124,92,255,0.14)] font-medium text-wv-violet'
                      : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>

          {showCreateOrg ? (
            <Link
              href="/create-org"
              className={`mt-3 block rounded-md px-3 py-2 text-sm transition ${
                isPathActive(pathname, '/create-org')
                  ? 'border-l-2 border-wv-violet bg-[rgba(124,92,255,0.14)] font-medium text-wv-violet'
                  : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
              }`}
            >
              Create Org
            </Link>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}
