import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  envDir: __dirname,
  server: { port: 5199, strictPort: false },
  build: { outDir: 'dist', emptyOutDir: true },
});
