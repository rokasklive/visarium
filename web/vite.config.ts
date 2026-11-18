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

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/health': { target: BACKEND, changeOrigin: false },
      '/ws': { target: BACKEND, ws: true, changeOrigin: false },
    },
  },
  build: {
    // Embedded into the server binary by rust-embed.
    outDir: 'dist',
    sourcemap: true,
  },
});
