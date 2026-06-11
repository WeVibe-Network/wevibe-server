import { ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant =
  | 'primary'
  | 'success'
  | 'secondary'
  | 'ghost'
  | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', ...props }, ref) => {
    const base =
      'inline-flex items-center justify-center rounded-[11px] px-[22px] py-3 font-sans text-[15px] font-semibold transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(124,92,255,0.35)] disabled:pointer-events-none disabled:opacity-50';
    const brandVariants = {
      primary:
        'bg-wv-grad-btn text-white shadow-[0_6px_20px_rgba(124,92,255,0.35)] hover:-translate-y-px hover:shadow-glow-v',
      success: 'bg-wv-green text-[#07140e] hover:brightness-105',
      secondary: 'border border-wv-line-2 bg-transparent text-wv-text hover:bg-wv-line',
      ghost: 'bg-transparent text-wv-dim hover:text-wv-text',
      danger:
        'border border-[rgba(255,107,107,0.4)] bg-transparent text-wv-red hover:bg-[rgba(255,107,107,0.12)]',
    } as const;
    return (
      <button
        ref={ref}
        className={`${base} ${brandVariants[variant]} ${className}`}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
export default Button;
