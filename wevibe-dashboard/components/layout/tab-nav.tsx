'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeSectionForPath, mainSectionsForState, type SubTab } from '@/lib/nav-config';
import { useDashboardState } from '@/lib/use-dashboard-state';

type IndicatorState = {
  left: number;
  width: number;
};

const EMPTY_SUBTABS: SubTab[] = [];

export default function TabNav() {
  const pathname = usePathname();
  const { state } = useDashboardState();

  const sections = useMemo(() => mainSectionsForState(state), [state]);
  const activeSection = useMemo(() => activeSectionForPath(sections, pathname), [sections, pathname]);
  const subTabs = activeSection?.sub ?? EMPTY_SUBTABS;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLAnchorElement | null>>(new Map());
  const [indicator, setIndicator] = useState<IndicatorState>({ left: 0, width: 0 });

  const activeHref = useMemo(() => {
    const activeTab = subTabs.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
    return activeTab?.href ?? null;
  }, [pathname, subTabs]);

  useLayoutEffect(() => {
    const measureIndicator = () => {
      let left = 0;
      let width = 0;
      if (containerRef.current && activeHref) {
        const activeTab = tabRefs.current.get(activeHref);
        if (activeTab) {
          left = activeTab.offsetLeft;
          width = activeTab.offsetWidth;
        }
      }
      setIndicator(prev => (prev.left === left && prev.width === width ? prev : { left, width }));
    };

    measureIndicator();
    window.addEventListener('resize', measureIndicator);

    return () => {
      window.removeEventListener('resize', measureIndicator);
    };
  }, [activeHref, pathname, subTabs]);

  if (subTabs.length <= 1) {
    return null;
  }

  return (
    <div className="border-b border-wv-line bg-wv-panel">
      <div className="overflow-x-auto">
        <div ref={containerRef} className="relative flex min-w-max items-center gap-1 px-6 py-2">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 top-1 rounded-full bg-[rgba(124,92,255,0.14)] ring-1 ring-[rgba(124,92,255,0.32)] transition-all duration-300 ease-out"
            style={{ left: indicator.left, width: indicator.width }}
          />

          {subTabs.map(({ label, href }) => {
            const isActive = activeHref === href;

            return (
              <Link
                key={href}
                href={href}
                ref={node => {
                  tabRefs.current.set(href, node);
                }}
                className={`relative z-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'text-wv-amber' : 'text-wv-dim hover:text-wv-text'
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
