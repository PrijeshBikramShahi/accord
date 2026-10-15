import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/cloud-web', plugins: [react()],
  server: { host: 'localhost', port: 5174, strictPort: true, headers: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } },
  build: { outDir: '../../dist/cloud-web', emptyOutDir: true },
});
