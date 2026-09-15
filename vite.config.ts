import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {alias: {'@': resolve(import.meta.dirname, '.')}},
  server: {host: '0.0.0.0', allowedHosts: ['terminal.local'], port: 5173, strictPort: true},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
});
