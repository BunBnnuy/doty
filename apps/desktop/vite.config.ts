import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and must not silently fall back to another one,
// otherwise `devUrl` in tauri.conf.json points at nothing.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // WebView2 on Windows is evergreen; this keeps output lean.
    target: 'chrome105',
    emptyOutDir: true,
  },
});
