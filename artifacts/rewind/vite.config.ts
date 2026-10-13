import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// PORT and BASE_PATH default for local use; /api is proxied to the API server in dev.
const port = Number(process.env.PORT ?? 5173);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
const basePath = process.env.BASE_PATH ?? '/';
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
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
