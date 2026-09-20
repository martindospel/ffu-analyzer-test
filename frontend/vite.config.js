import { defineConfig } from 'vite'

// The backend serves everything under /api, so the dev server just forwards it.
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
})