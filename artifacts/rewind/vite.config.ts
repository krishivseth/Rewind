import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// Replit sets PORT and BASE_PATH per artifact; locally we default them and proxy /api to the API server.
const port = Number(process.env.PORT ?? 5173);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
const basePath = process.env.BASE_PATH ?? '/';
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // On Replit the platform routes /api to the API artifact; locally Vite proxies it.
    proxy: process.env.REPL_ID ? undefined : { '/api': { target: apiTarget, changeOrigin: false } },
  },
  test: { environment: 'node', include: ['src/__tests__/**/*.test.ts'] },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
