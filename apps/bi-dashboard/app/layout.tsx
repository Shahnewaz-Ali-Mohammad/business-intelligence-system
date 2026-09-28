import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/components/auth/auth-provider';

// FIX 2026-09-28: globals.css already declared --font-sans: Inter as the
// design system's font, but nothing ever actually loaded Inter -- there
// was no next/font import and no <link> to Google Fonts, so every browser
// silently fell back to its own default system-ui/sans-serif stack. The
// whole app LOOKED like it was using a plain OS font because it was --
// this is what actually wires the real Inter font in, with next/font
// self-hosting it (no external request, no layout shift) and exposing it
// as the same --font-sans variable the CSS already expects.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Business Intelligence System',
  description: 'Read-only conversational business intelligence dashboard.',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body suppressHydrationWarning className="font-sans antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
