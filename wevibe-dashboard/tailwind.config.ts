import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'wv-bg': '#09090f',
        'wv-bg-2': '#0c0c14',
        'wv-panel': '#14141e',
        'wv-panel-2': '#1a1a26',
        'wv-panel-3': '#222230',
        'wv-line': 'rgba(255,255,255,0.08)',
        'wv-line-2': 'rgba(255,255,255,0.16)',
        'wv-violet': '#7c5cff',
        'wv-violet-deep': '#5a3fe0',
        'wv-indigo': '#4b6bff',
        'wv-cyan': '#34dcf0',
        'wv-cyan-deep': '#19a5c2',
        'wv-amber': '#ffb255',
        'wv-green': '#36d399',
        'wv-red': '#ff6b6b',
        'wv-text': '#ecedf6',
        'wv-dim': 'rgba(236,237,246,0.56)',
        'wv-faint': 'rgba(236,237,246,0.30)',
      },
      fontFamily: {
        sans: ['var(--wv-sans)', 'Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['var(--wv-mono)', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '22px',
        pill: '999px',
      },
      boxShadow: {
        'wv-sm': '0 8px 24px rgba(0,0,0,0.4)',
        'wv-md': '0 18px 44px rgba(0,0,0,0.5)',
        'wv-lg': '0 30px 80px rgba(0,0,0,0.55)',
        'glow-v': '0 0 48px rgba(124,92,255,0.45)',
        'glow-c': '0 0 48px rgba(52,220,240,0.40)',
      },
      backgroundImage: {
        'wv-grad': 'linear-gradient(135deg, #7c5cff 0%, #34dcf0 100%)',
        'wv-grad-btn': 'linear-gradient(135deg, #7c5cff 0%, #4b6bff 100%)',
      },
    },
  },
  plugins: [],
};

export default config;
