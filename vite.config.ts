import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  // SQLite WASM OPFS requires an isolated context. `credentialless` preserves
  // that requirement without blocking public R2 image responses.
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] }
})
