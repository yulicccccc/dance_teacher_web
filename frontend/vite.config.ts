import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pure browser build: no backend proxy. `base: './'` makes the bundle portable
// (works from any static host / CloudStudio subpath). The worker is emitted as
// an ES module so `new Worker(new URL('./beat.worker.ts', import.meta.url))`
// resolves correctly under Vite.
export default defineConfig({
  plugins: [react()],
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
  },
})
