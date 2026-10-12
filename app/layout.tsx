import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'iScale Listings — Trademark API',
  description:
    'Screen text against the USPTO + EUIPO trademark databases. The API behind the iScale Listings browser extension and SDK.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
