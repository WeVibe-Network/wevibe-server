export type SubTab = { label: string; href: string };

export type MainSection = { label: string; key: string; sub: SubTab[] };

export const MAIN_NAV_BY_STATE: Record<string, MainSection[]> = {
  NO_IDENTITY: [],
  IDENTITY_NO_ORG: [
    {
      label: 'My Org',
      key: 'my-org',
      sub: [{ label: 'Overview', href: '/my-org' }],
    },
    {
      label: 'Discover',
      key: 'discover',
      sub: [{ label: 'Discover', href: '/discover' }],
    },
  ],
  CONNECTED_LEADER: [
    {
      label: 'My Org',
      key: 'my-org',
      sub: [
        { label: 'Overview', href: '/my-org' },
        { label: 'Members', href: '/members' },
        { label: 'Requests', href: '/join-requests' },
        { label: 'Epochs', href: '/epoch' },
        { label: 'Billing', href: '/billing' },
        { label: 'Recovery', href: '/recovery' },
        { label: 'Org Settings', href: '/settings' },
      ],
    },
    {
      label: 'Moderation',
      key: 'moderation',
      sub: [
        { label: 'New', href: '/moderation/new' },
        { label: 'Reported', href: '/moderation/reported' },
        { label: 'History', href: '/moderation/history' },
      ],
    },
  ],
  CONNECTED_MODERATOR: [
    {
      label: 'My Org',
      key: 'my-org',
      sub: [
        { label: 'Overview', href: '/my-org' },
        { label: 'My Submissions', href: '/my-submissions' },
        { label: 'Requests', href: '/join-requests' },
      ],
    },
    {
      label: 'Moderation',
      key: 'moderation',
      sub: [
        { label: 'New', href: '/moderation/new' },
        { label: 'Reported', href: '/moderation/reported' },
        { label: 'History', href: '/moderation/history' },
      ],
    },
    {
      label: 'Sessions',
      key: 'sessions',
      sub: [
        { label: 'Extract', href: '/sessions' },
        { label: 'Extracted', href: '/sessions/extracted' },
      ],
    },
  ],
  CONNECTED_CONTRIBUTOR: [
    {
      label: 'My Org',
      key: 'my-org',
      sub: [
        { label: 'Overview', href: '/my-org' },
        { label: 'My Submissions', href: '/my-submissions' },
      ],
    },
    {
      label: 'Sessions',
      key: 'sessions',
      sub: [
        { label: 'Extract', href: '/sessions' },
        { label: 'Extracted', href: '/sessions/extracted' },
      ],
    },
  ],
  CONNECTED_MEMBER: [
    {
      label: 'My Org',
      key: 'my-org',
      sub: [{ label: 'Overview', href: '/my-org' }],
    },
    {
      label: 'Discover',
      key: 'discover',
      sub: [{ label: 'Discover', href: '/discover' }],
    },
  ],
};

export const GENERAL_NAV: SubTab[] = [
  { label: 'Discover', href: '/discover' },
  { label: 'Activity', href: '/activity' },
  { label: 'Notifications', href: '/notifications' },
  { label: 'Faucet', href: '/faucet' },
  { label: 'Profile', href: '/profile' },
  { label: 'Pipeline Health', href: '/health' },
];

const EMPTY_SECTIONS: MainSection[] = [];

export function mainSectionsForState(state: string): MainSection[] {
  return MAIN_NAV_BY_STATE[state] ?? EMPTY_SECTIONS;
}

export function activeSectionForPath(sections: MainSection[], pathname: string): MainSection | null {
  return sections.find(section => section.sub.some(tab => pathname === tab.href || pathname.startsWith(`${tab.href}/`))) ?? null;
}
