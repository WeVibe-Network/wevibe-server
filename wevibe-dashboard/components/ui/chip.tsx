interface ChipProps {
  label: string;
  onRemove?: () => void;
}

export default function Chip({ label, onRemove }: ChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-[rgba(124,92,255,0.4)] bg-[rgba(124,92,255,0.14)] px-3 py-1 font-mono text-[12.5px] tracking-[0.03em] text-wv-violet">
      {label}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="text-wv-dim transition hover:text-wv-text"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
