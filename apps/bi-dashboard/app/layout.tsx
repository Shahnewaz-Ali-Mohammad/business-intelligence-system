import type { Metadata } from 'next';
import './globals.css';

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
      <body>{children}</body>
    </html>
  );
}
