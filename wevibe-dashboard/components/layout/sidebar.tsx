'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useOrgContext } from '@/lib/org-context';
import type { OrgRole } from '@/lib/org-role';

interface NavItem {
  href: string;
  label: string;
  roles?: OrgRole[];
}

const nav: NavItem[] = [
  { href: '/health', label: 'Pipeline Health' },
  { href: '/faucet', label: 'Faucet' },
  { href: '/activity', label: 'Activity' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/my-submissions', label: 'My Submissions' },
  { href: '/moderation', label: 'Moderation', roles: ['leader', 'moderator'] },
  { href: '/chain-submit', label: 'Batch Pipeline', roles: ['leader'] },
  { href: '/reports', label: 'Reports', roles: ['leader', 'moderator'] },
  { href: '/memories', label: 'Memories' },
  { href: '/discover', label: 'Discover Orgs' },
  { href: '/members', label: 'Members', roles: ['leader'] },
  { href: '/join-requests', label: 'Join Requests', roles: ['leader', 'moderator'] },
  { href: '/keywords', label: 'Keywords', roles: ['leader'] },
  { href: '/recovery', label: 'Recovery', roles: ['leader'] },
  { href: '/epoch', label: 'Epochs', roles: ['leader'] },
  { href: '/billing', label: 'Billing' },
  { href: '/profile', label: 'Profile' },
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

  const visibleNav = nav.filter(item => {
    if (!item.roles) return true;
    return item.roles.includes(userRole);
  });

  return (
    <aside className="flex w-56 flex-col border-r border-wv-line bg-wv-panel">
      <div className="border-b border-wv-line px-4 py-5">
        <span className="font-semibold text-wv-text">WeVibe Network</span>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {showCreateOrg && (
          <Link
            href="/create-org"
            className={`block px-3 py-2 rounded-md text-sm ${
              path.startsWith('/create-org')
                ? 'bg-[rgba(124,92,255,0.14)] font-medium text-wv-violet'
                : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
            }`}
          >
            Create Org
          </Link>
        )}
        {visibleNav.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            data-testid={`nav-${href.slice(1)}`}
            className={`block px-3 py-2 rounded-md text-sm ${
              path.startsWith(href)
                ? 'bg-[rgba(124,92,255,0.14)] font-medium text-wv-violet'
                : 'text-wv-dim hover:bg-wv-line hover:text-wv-text'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
