'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listKeywords } from '@/lib/hub-client';
import { useDashboardState } from '@/lib/use-dashboard-state';

export function KeywordSeedingBanner(): JSX.Element | null {
  const { isLeader, activeOrg } = useDashboardState();
  const orgId = activeOrg?.org_id;
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (!isLeader || !orgId) {
      setShowBanner(false);
      return;
    }

    let active = true;

    void listKeywords(orgId)
      .then((keywords) => {
        if (active) {
          setShowBanner(keywords.filter((k) => !k.deprecated).length === 0);
        }
      })
      .catch(() => {
        if (active) {
          setShowBanner(false);
        }
      });

    return () => {
      active = false;
    };
  }, [orgId, isLeader]);

  if (!isLeader || !showBanner) {
    return null;
  }

  return (
    <div
      data-testid="keyword-seeding-banner"
      className="mx-6 mt-4 rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] px-3 py-2 text-sm text-wv-amber"
    >
      <p>
        keywords not seeded - caution! - memory extraction degraded. please add keyword set{' '}
        <Link
          href="/org-settings#keywords"
          data-testid="keyword-seeding-here-link"
          className="underline underline-offset-2 hover:opacity-80"
        >
          here
        </Link>{' '}
        for extraction + recall conformity
      </p>
    </div>
  );
}
