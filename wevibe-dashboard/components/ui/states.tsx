import type { JSX, ReactNode } from 'react';
import Card from '@/components/ui/card';

export function LoadingState({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }): JSX.Element {
  const safeRows = Math.max(1, rows);
  const widthClasses = ['w-full', 'w-11/12', 'w-10/12', 'w-9/12'];

  return (
    <Card className="p-5">
      <div className="space-y-3">
        <p className="text-sm text-wv-dim">{label}</p>
        <div className="space-y-2 animate-pulse">
          {Array.from({ length: safeRows }).map((_, index) => (
            <div
              key={index}
              className={`h-3 rounded bg-wv-panel-2 ${widthClasses[index % widthClasses.length]}`}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Card className="p-8 text-center">
      <h2 className="text-base font-medium text-wv-text">{title}</h2>
      {description ? <p className="mt-2 text-sm text-wv-dim">{description}</p> : null}
      {children ? <div className="mt-4 flex justify-center">{children}</div> : null}
    </Card>
  );
}

export function GuardCard({
  title = 'You\'re not in an organization yet.',
  children,
}: {
  title?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-[rgba(255,178,85,0.4)] bg-[rgba(255,178,85,0.12)] p-4 text-wv-amber">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.12)] px-3 py-2 text-sm text-wv-red">
      {children}
    </div>
  );
}
