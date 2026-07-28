import { defineConfig } from 'vitest/config'

// Vitest config for the SPA. Intentionally NO @vitejs/plugin-react here (it
// crashes vitest's config loader in this sandbox). esbuild transpiles JSX via
// the automatic runtime, which is all the unit/component tests need. The dev
// server keeps react() in vite.config.ts.
//
// setup.ts pulls in fake-indexeddb so the large-result IndexedDB fallback in
// useLocalProgress can run under jsdom.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // jsdom does not implement these; stub so components that touch them don't
    // throw during render (video.play(), fullscreen, matchMedia, etc.).
    css: false,
  },
})
