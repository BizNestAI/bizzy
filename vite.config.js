// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Use BACKEND_URL if you set it in .env, else default to localhost:5050
const API_TARGET = process.env.BACKEND_URL || 'http://localhost:5050';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: process.cwd(),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      // Forward all /api requests to your Express server during dev
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
        ws: true,              // if you ever proxy websockets
        // keep path as-is (no rewrite) since your backend expects /api/*
        // rewrite: (p) => p,  // not needed, left here for clarity
      },
    },
  },
});
