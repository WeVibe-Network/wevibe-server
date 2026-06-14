/**
 * Maps backend preference_confidence (0..1) into a user-facing preference percent (0..100).
 * Higher percent means the memory is more taste/subjective and less durable over time.
 * Lower percent means the memory is more factual and durable.
 */

export type PreferenceDurability = 'durable' | 'mixed' | 'subjective';

export interface PreferenceScore {
  percent: number;
  label: string;
  durability: PreferenceDurability;
  toneClassName: string;
  title: string;
}

const TONE_CLASS_NAMES: Record<PreferenceDurability, string> = {
  durable: 'border-[rgba(54,211,153,0.45)] bg-[rgba(54,211,153,0.16)] text-wv-green',
  mixed: 'border-[rgba(255,178,85,0.45)] bg-[rgba(255,178,85,0.16)] text-wv-amber',
  subjective: 'border-[rgba(255,107,107,0.45)] bg-[rgba(255,107,107,0.16)] text-wv-red',
};

const LABELS: Record<PreferenceDurability, string> = {
  durable: 'Durable',
  mixed: 'Mixed',
  subjective: 'Subjective',
};

export function getPreferenceScore(confidence: number): PreferenceScore {
  const normalized = Number.isFinite(confidence) ? confidence : 0;
  const clamped = Math.min(1, Math.max(0, normalized));
  const percent = Math.round(clamped * 100);

  const durability: PreferenceDurability =
    percent <= 20 ? 'durable' : percent >= 60 ? 'subjective' : 'mixed';

  return {
    percent,
    label: LABELS[durability],
    durability,
    toneClassName: TONE_CLASS_NAMES[durability],
    title: `Preference ${percent}% — higher means more subjective/taste; lower means more factual and durable.`,
  };
}
