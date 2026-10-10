import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard's api.js falls back to a relative "/api" path when VITE_API_URL
// is unset, so in dev we proxy /api to FastAPI. Same origin as far as the browser
// is concerned, which means CORS never enters the picture during development.
// Override the backend port with VITE_API_TARGET if uvicorn runs somewhere else.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
});
