import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      // Regex context (leading '^') so this only matches API calls
      // (/api/detect-anomaly, ...) and not the frontend's own /api.js module,
      // which a plain '/api' prefix-match would otherwise intercept and 404.
      '^/api/': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
