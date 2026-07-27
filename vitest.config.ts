import { defineConfig } from 'vitest/config'

// NOTE: intentionally NO @vitejs/plugin-react here. The plugin's config hook
// crashes vitest's config loader in this sandbox, silently dropping us to the
// node environment. esbuild handles JSX via the automatic runtime below, which
// is all the unit/component tests need. The dev server keeps react() in
// vite.config.ts.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
