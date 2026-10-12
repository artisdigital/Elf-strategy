import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web client lives in src/web; the API server (src/server) serves the built
// files in production and is proxied here during development.
export default defineConfig({
  root: 'src/web',
  publicDir: '../../public',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
});
