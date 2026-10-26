// Author, creator and maintainer: Dhruba Poudel.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 65458, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    proxy: { '/api': { target: 'http://127.0.0.1:65457', changeOrigin: true } }
  }
});
