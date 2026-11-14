// Bench-only build: the production app + a seeding page on the same origin (so it shares OPFS/SQLite).
// The production build (vite.config.ts / Vercel) is NOT affected by this file.
import { defineConfig, mergeConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import base from '../vite.config'

// The bench app talks to bench/mock-cloud.mjs on localhost — never to the live Cloudflare Worker or R2 bucket.
process.env.VITE_API_BASE_URL = 'http://localhost:4330/api'
process.env.VITE_R2_PUBLIC_BASE_URL = 'http://localhost:4330/r2'

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
