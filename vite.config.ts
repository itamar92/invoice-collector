import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev:ui` serves the UI on :5173 and proxies /api to the API server (`npm run dev`, PORT 3100).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.PORT || 3100}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
