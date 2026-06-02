import type { Metadata } from 'next';
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const wvSans = Space_Grotesk({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--wv-sans',
  display: 'swap',
});

const wvMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--wv-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'WeVibe Network',
  description: 'Org-scoped encrypted process memory',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${wvSans.variable} ${wvMono.variable}`}>
      <body className="min-h-screen bg-wv-bg font-sans text-wv-text antialiased">{children}</body>
    </html>
  );
}
