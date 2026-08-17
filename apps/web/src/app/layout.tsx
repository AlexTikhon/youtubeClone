import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { QueryProvider } from '@/shared/query/query-provider';
import { AppHeader } from '@/widgets/app-header/app-header';

import './globals.css';

export const metadata: Metadata = {
  title: 'YouTubeClone',
  description: 'A production-minded educational video platform',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <QueryProvider>
          <AppHeader />
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </QueryProvider>
      </body>
    </html>
  );
}
