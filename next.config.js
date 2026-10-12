/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Applied to every response. The API serves JSON only, so these are
        // cheap defense-in-depth (no HTML rendering surface), but expected on a
        // public API. CORS headers are set per-route in lib/http/cors.ts.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
