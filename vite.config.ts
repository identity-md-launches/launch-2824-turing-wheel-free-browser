import { defineConfig } from 'vitest/config';

// Relative base so the build runs from any IPFS gateway subpath or ENS name.
/** Vite's dev server injects styles and a websocket, which the production CSP rightly refuses. */
const dropCspInDev = {
  name: 'drop-csp-in-dev',
  apply: 'serve',
  transformIndexHtml: (html: string) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, ''),
} as const;

export default defineConfig({
  base: './',
  plugins: [dropCspInDev],
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { include: ['src/**/*.test.ts'] },
});
