import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pure static SPA — no backend proxy. The browser extracts audio (ffmpeg.wasm)
// and detects beats (essentia.js) entirely client-side, so there is nothing to
// proxy to. WASM / worker assets are self-hosted under /wasm (see
// scripts/copy-wasm.mjs) and loaded via `?url` / dynamic import, which Vite
// handles natively — no extra plugin config required.
export default defineConfig({
  plugins: [react()],
  // ffmpeg.wasm / essentia wasm can be large; allow chunk sizes to exceed the
  // default warning threshold so the build stays silent for the wasm glue.
  build: {
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
  },
})
