// Bench-only build: the production app + a seeding page on the same origin (so it shares OPFS/SQLite).
// The production build (vite.config.ts / Vercel) is NOT affected by this file.
import { defineConfig, mergeConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import base from '../vite.config'

const root = fileURLToPath(new URL('..', import.meta.url))
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' }

export default mergeConfig(base, defineConfig({
  root,
  build: {
    outDir: 'bench/.dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: `${root}index.html`, seed: `${root}bench/seed.html` } }
  },
  preview: { headers: isolation }
}))
