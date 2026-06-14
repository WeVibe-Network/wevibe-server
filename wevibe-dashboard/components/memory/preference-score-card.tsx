import { getPreferenceScore } from '@/lib/preference-score';

export interface PreferenceScoreCardProps {
  confidence: number | null | undefined;
  className?: string;
}

export function PreferenceScoreCard({ confidence, className }: PreferenceScoreCardProps) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return null;
  }

  const { percent, label, toneClassName, title } = getPreferenceScore(confidence);
  const mergedClassName = [
    'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
    toneClassName,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={mergedClassName} title={title}>
      <span className="text-base font-semibold leading-none">{percent}%</span>
      <span className="text-wv-dim">preference</span>
      <span className="font-medium">{label}</span>
    </div>
  );
}
