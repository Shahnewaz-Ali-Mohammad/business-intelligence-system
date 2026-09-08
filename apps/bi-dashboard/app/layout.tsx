import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/auth/auth-provider';

export const metadata: Metadata = {
  title: 'Business Intelligence System',
  description: 'Read-only conversational business intelligence dashboard.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
