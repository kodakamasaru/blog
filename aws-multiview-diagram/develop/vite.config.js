import { defineConfig } from 'vite';

export default defineConfig({
  root: 'viewer',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5178, strictPort: true },
  preview: { port: 5178, strictPort: true },
});
