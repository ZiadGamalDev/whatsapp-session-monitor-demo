import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/',
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    // Keep every asset as a file: the CSP does not allow data: fonts.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
});
