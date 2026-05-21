'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrgContext } from '@/lib/org-context';

type Role = 'leader' | 'moderator' | 'member';

interface NavItem {
  href: string;
  label: string;
  roles?: Role[];
}

const nav: NavItem[] = [
  { href: '/health', label: 'Pipeline Health' },
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

const showCreateOrg = typeof window === 'undefined' ? false : !process.env.NEXT_PUBLIC_ORG_ID;

export default function Sidebar() {
  const path = usePathname();
  const { activeOrg } = useOrgContext();
  const userRole: Role = activeOrg?.role || 'member';

  const visibleNav = nav.filter(item => {
    if (!item.roles) return true;
    return item.roles.includes(userRole);
  });

  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-5 border-b border-gray-200">
        <span className="font-semibold text-gray-900">WeVibe Network</span>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {showCreateOrg && (
          <Link
            href="/create-org"
            className={`block px-3 py-2 rounded-md text-sm ${
              path.startsWith('/create-org')
                ? 'bg-gray-100 font-medium text-gray-900'
                : 'text-gray-600 hover:bg-gray-50'
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
                ? 'bg-gray-100 font-medium text-gray-900'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
