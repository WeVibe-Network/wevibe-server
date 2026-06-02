type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'violet' | 'cyan';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export default function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  const variants: Record<BadgeVariant, string> = {
    default: 'text-wv-cyan bg-[rgba(52,220,240,0.12)] border-[rgba(52,220,240,0.4)]',
    cyan: 'text-wv-cyan bg-[rgba(52,220,240,0.12)] border-[rgba(52,220,240,0.4)]',
    success: 'text-wv-green bg-[rgba(54,211,153,0.12)] border-[rgba(54,211,153,0.4)]',
    warning: 'text-wv-amber bg-[rgba(255,178,85,0.12)] border-[rgba(255,178,85,0.4)]',
    error: 'text-wv-red bg-[rgba(255,107,107,0.12)] border-[rgba(255,107,107,0.4)]',
    violet: 'text-wv-violet bg-[rgba(124,92,255,0.14)] border-[rgba(124,92,255,0.4)]',
  };
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-3 py-1 font-mono text-[12.5px] tracking-[0.03em] ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
