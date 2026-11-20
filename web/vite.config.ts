import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Development runs Vite and the Rust server side by side; the proxy below makes
 * them look like one origin so cookies, CSRF and relative URLs behave exactly as
 * they will in production, where the server embeds the built bundle itself.
 */
const BACKEND = process.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

// The same UTC build stamp travels with the embedded desktop and server bundle.
const BUILD = new Date()
  .toISOString()
  .slice(0, 16)
  .replace(/-/g, '.')
  .replace('T', '.')
  .replace(':', '');

export default defineConfig(({ mode }) => ({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '~', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // A production build gets no inspector: its loader is swapped for a stub
      // (spec: canvas/inspector; checked by scripts/check-bundle.mjs).
      ...(mode === 'production'
        ? [
            {
              find: /^\.\.\/inspector\/load$/,
              replacement: fileURLToPath(
                new URL('./src/features/inspector/none.ts', import.meta.url),
              ),
            },
          ]
        : []),
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/health': { target: BACKEND, changeOrigin: false },
      '/ws': { target: BACKEND, ws: true, changeOrigin: false },
      // The agent endpoint (ADR-0031), so an agent can use the dev origin too.
      '/mcp': { target: BACKEND, changeOrigin: false },
    },
  },
  optimizeDeps: {
    // The object renderers are dynamic imports. Pre-bundled up front, the dev
    // server never discovers them mid-session and reloads the page under a
    // test. PlantUML is one ES module already, and 7 MB is not worth bundling.
    include: ['mermaid', 'marked', 'dompurify'],
    exclude: ['@plantuml/core'],
  },
  build: {
    // Embedded into the server binary by rust-embed.
    outDir: 'dist',
    sourcemap: true,
  },
  // `pnpm build:dev`: a deployable bundle WITH the inspector, for a dev
  // environment that runs the real server image (spec: canvas/inspector).
  // Defined in EVERY mode, so `DEVTOOLS` is a literal at build time and Rollup
  // drops the inspector's dynamic import. Left undefined, it would be read at
  // run time, and the chunk would ship (check:bundle caught exactly that).
  define: {
    'import.meta.env.VITE_DEVTOOLS': JSON.stringify(mode === 'devtools' ? '1' : ''),
    __VISARIUM_BUILD__: JSON.stringify(BUILD),
  },
}));
