import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: {
    target: 'chrome53', cssTarget: 'chrome53', modulePreload: false, sourcemap: false,
    rollupOptions: { output: { format: 'iife', name: 'NightOwly', entryFileNames: 'assets/app.js', assetFileNames: 'assets/[name][extname]' } }
  }
});
