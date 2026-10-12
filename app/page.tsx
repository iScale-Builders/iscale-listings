import { notFound } from 'next/navigation';
import { privateModeEnabled } from '@/lib/auth/private-mode';

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || 'https://github.com/iScale-Builders/iscale-listings';

// Read REQUIRE_API_KEY at request time, not at build time.
export const dynamic = 'force-dynamic';

export default function Home() {
  // Private mode: the deployment shows nothing to visitors.
  if (privateModeEnabled()) notFound();
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '3rem 1.5rem',
        lineHeight: 1.6,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1>iScale Listings — Trademark API</h1>
      <p>
        A trademark screening API that checks text against the USPTO and EUIPO
        databases. It powers the iScale Listings browser extension and the
        JavaScript SDK.
      </p>

      <h2>Endpoints</h2>
      <ul>
        <li>
          <code>POST /api/v1/check</code> — screen text for trademark conflicts
        </li>
        <li>
          <code>POST /api/v1/check/batch</code> — screen multiple items at once
        </li>
        <li>
          <code>GET /api/v1/health</code> — service status and data freshness
        </li>
      </ul>

      <p>
        See the{' '}
        <a href={REPO_URL} rel="noreferrer">
          project README
        </a>{' '}
        for setup, the SDK, the extension, and how to run your own instance.
      </p>
    </main>
  );
}
