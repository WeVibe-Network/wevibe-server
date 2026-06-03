import type { JSX } from 'react';
import type { OrgRole } from '@/lib/org-role';

export function roleColor(role: OrgRole | string): string {
  switch (role.toLowerCase()) {
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

export function RoleBadge({ role, className }: { role: OrgRole | string; className?: string }): JSX.Element {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${roleColor(role)} ${className ?? ''}`}
    >
      {role}
    </span>
  );
}
