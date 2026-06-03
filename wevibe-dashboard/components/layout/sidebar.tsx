'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useOrgContext } from '@/lib/org-context';
import type { OrgRole } from '@/lib/org-role';

const topNav: { href: string; label: string }[] = [
  { href: '/memories', label: 'Memories' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/my-submissions', label: 'My Submissions' },
  { href: '/discover', label: 'Discover Orgs' },
  { href: '/activity', label: 'Activity' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/faucet', label: 'Faucet' },
  { href: '/profile', label: 'Profile' },
  { href: '/health', label: 'Pipeline Health' },
];

const orgNav: { href: string; label: string; roles: OrgRole[] }[] = [
  { href: '/moderation', label: 'Moderation', roles: ['leader', 'moderator'] },
  { href: '/reports', label: 'Reports', roles: ['leader', 'moderator'] },
  { href: '/join-requests', label: 'Join Requests', roles: ['leader', 'moderator'] },
  { href: '/members', label: 'Members', roles: ['leader'] },
  { href: '/keywords', label: 'Keywords', roles: ['leader'] },
  { href: '/chain-submit', label: 'Batch Pipeline', roles: ['leader'] },
  { href: '/epoch', label: 'Epochs', roles: ['leader'] },
  { href: '/billing', label: 'Billing', roles: ['leader'] },
  { href: '/recovery', label: 'Recovery', roles: ['leader'] },
  { href: '/settings', label: 'Settings', roles: ['leader'] },
];

export default function Sidebar() {
  const path = usePathname();
  const { activeOrg } = useOrgContext();
  const [showCreateOrg, setShowCreateOrg] = useState(false);

  useEffect(() => {
    setShowCreateOrg(!process.env.NEXT_PUBLIC_ORG_ID);
  }, []);

  const userRole: OrgRole = activeOrg?.role || 'member';
  const hasOrg = !!activeOrg;
  const visibleOrgNav = orgNav.filter(item => item.roles.includes(userRole));

  const navLink = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      data-testid={`nav-${href.slice(1)}`}
      className={`block rounded-md px-3 py-2 text-sm transition ${
        path.startsWith(href)
          ? 'border-l-2 border-wv-violet bg-[rgba(124,92,255,0.14)] font-medium text-wv-violet'
          : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
      }`}
    >
      {label}
    </Link>
  );

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

  return (
    <aside className="flex w-56 flex-col border-r border-wv-line bg-wv-panel">
      <div className="border-b border-wv-line px-4 py-5">
        <span className="font-semibold text-wv-text">WeVibe Network</span>
      </div>
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {showCreateOrg && (
          <Link
            href="/create-org"
            className={`block rounded-md px-3 py-2 text-sm ${
              path.startsWith('/create-org')
                ? 'bg-[rgba(124,92,255,0.14)] font-medium text-wv-violet'
                : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
            }`}
          >
            Create Org
          </Link>
        )}

        {topNav.map(({ href, label }) => navLink(href, label))}

        {hasOrg && (
          <div className="mt-4 rounded-xl border border-[rgba(124,92,255,0.28)] bg-wv-panel-2 p-3 shadow-[0_0_28px_rgba(124,92,255,0.16)]">
            <Link href="/my-org" className="group block">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-wv-faint">My Org</span>
              <p className="mt-1.5 truncate text-sm font-medium text-wv-text transition group-hover:text-wv-violet" title={activeOrg?.org_name}>
                {activeOrg?.org_name}
              </p>
            </Link>
            <span
              className={`mt-1.5 inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${rolePillClass(
                userRole,
              )}`}
            >
              {userRole}
            </span>
            {visibleOrgNav.length > 0 && (
              <div className="mt-3 space-y-1">
                {visibleOrgNav.map(({ href, label }) => navLink(href, label))}
              </div>
            )}
          </div>
        )}
      </nav>
    </aside>
  );
}
