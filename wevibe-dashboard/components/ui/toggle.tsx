'use client';

interface ToggleProps {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

export default function Toggle({
  id,
  checked,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className = '',
}: ToggleProps) {
  const trackStateClass = checked ? 'bg-wv-violet' : 'bg-wv-line-2';
  const knobPositionClass = checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5';

  const handleClick = () => {
    if (disabled) {
      return;
    }
    onChange(!checked);
  };

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={handleClick}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)] disabled:cursor-not-allowed disabled:opacity-50 ${trackStateClass} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow-wv-sm transition-transform ${knobPositionClass}`}
      />
    </button>
  );
}
