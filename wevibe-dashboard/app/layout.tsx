import type { Metadata } from 'next';
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { readConfigFromEnv } from '@/lib/config';
import { ClientErrorCapture } from '@/components/diagnostics/client-error-capture';
import { Toaster } from 'sonner';
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
  const cfg = readConfigFromEnv();

  return (
    <html lang="en" className={`${wvSans.variable} ${wvMono.variable}`}>
      <body className="min-h-screen bg-wv-bg font-sans text-wv-text antialiased">
        <script
          id="wevibe-config"
          dangerouslySetInnerHTML={{ __html: `window.__WEVIBE_CONFIG__=${JSON.stringify(cfg)}` }}
        />
        <ClientErrorCapture>{children}</ClientErrorCapture>
        <Toaster richColors position="bottom-right" theme="dark" expand />
      </body>
    </html>
  );
}
