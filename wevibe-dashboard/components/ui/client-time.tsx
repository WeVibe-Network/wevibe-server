'use client';

import { useState, useEffect } from 'react';

export type ClientTimeMode = 'relative' | 'datetime' | 'date' | 'datetime-compact';

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatValue(value: string | number | Date, mode: ClientTimeMode): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  switch (mode) {
    case 'relative':
      return formatRelative(d);
    case 'date':
      return d.toLocaleDateString();
    case 'datetime-compact':
      return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    case 'datetime':
    default:
      return d.toLocaleString();
  }
}

export default function ClientTime({
  value,
  mode = 'datetime',
  fallback = 'Never',
  className,
}: {
  value: string | number | Date | null | undefined;
  mode?: ClientTimeMode;
  fallback?: string;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const hasValue = value !== null && value !== undefined && value !== '';
  // Server + first client render: render the fallback (stable, non-locale) so SSR == first CSR.
  // After mount: render the localized string.
  const text = mounted && hasValue ? formatValue(value as string | number | Date, mode) : fallback;

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
