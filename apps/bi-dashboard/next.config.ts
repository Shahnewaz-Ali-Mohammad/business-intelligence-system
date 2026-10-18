import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(import.meta.url));
// FIX 2026-09-29: this used to pin Turbopack's root to bi-dashboard itself
// (appRoot) -- fine as long as nothing bundled by Next ever reached outside
// this folder. That stopped being true the moment app/api/exports/customers
// -- a real Next.js route, compiled by Turbopack, unlike the plain-node
// chat scripts -- started importing the bi-warehouse services layer
// directly (streamAllCustomerFinancials) instead of only going through the
// warehouse's MCP tool layer. Turbopack refuses to resolve/bundle any
// import that lands outside its configured root, so that import failed
// with "Module not found" even though the file genuinely exists on disk --
// confirmed live (see the build-error screenshot this fixes). Widening the
// root to the repository also includes the shared warehouse and Cube model.
const monorepoRoot = join(appRoot, '..', '..');

const nextConfig: NextConfig = {
  serverExternalPackages: ['pdfkit'],
  outputFileTracingRoot: monorepoRoot,
  outputFileTracingIncludes: {
    '/api/**': ['../../cube/model/isp.yml'],
  },
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
