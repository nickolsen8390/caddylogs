import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          geo: ['d3-geo', 'topojson-client'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // `npm run dev` against a running stack: API calls go to the container.
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:8899',
        changeOrigin: false,
      },
    },
  },
});
