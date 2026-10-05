import { defineConfig } from 'vite';

/**
 * Dev/demo server.
 *
 * Bound to all interfaces and with Vite's host allow-list disabled so the demo
 * is reachable through the machine's public hostname (93130123.xyz) as well as
 * localhost. `strictPort` keeps it on 5173 so the URL is predictable.
 */
export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    strictPort: true,
  },
  build: {
    // Static demo output, kept separate from the `dist/` library build (tsc).
    outDir: 'demo-dist',
    emptyOutDir: true,
  },
});
