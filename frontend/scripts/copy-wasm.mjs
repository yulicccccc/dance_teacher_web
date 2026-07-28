// Copy browser-side WASM assets from node_modules into public/wasm so they are
// self-hosted (same-origin) in the static build. Same-origin hosting is
// required so the files load cleanly under Cloudflare Pages' COEP
// `require-corp` header (see public/_headers) without extra CORP annotations.
//
// Assets copied:
//   - @ffmpeg/core        -> public/wasm/ffmpeg/core/        (single-thread fallback)
//   - @ffmpeg/core-mt     -> public/wasm/ffmpeg/core-mt/     (multi-thread, needs SAB)
//   - essentia.js         -> public/wasm/essentia/           (RhythmExtractor2013)
//
// Run automatically before `dev` and `build` via the npm `predev`/`prebuild`
// hooks, but can also be invoked directly: `npm run copy:wasm`.

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(projectRoot, 'node_modules')
const outRoot = join(projectRoot, 'public', 'wasm')

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

/** Recursively search a directory for the first file matching `re`. */
function scanFor(dir, re) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = scanFor(full, re)
      if (found) return found
    } else if (re.test(entry.name)) {
      return full
    }
  }
  return null
}

/**
 * Resolve a source file inside a package directory. Tries the exact candidate
 * paths first (handles both the `dist/umd` and `dist/esm` layouts across
 * @ffmpeg/* versions), then falls back to a recursive scan so the script keeps
 * working if a future package version reorganises its dist folder.
 */
function findInPackage(pkgRel, candidates, scanRe) {
  const pkgDir = join(nodeModules, pkgRel)
  if (!existsSync(pkgDir)) {
    throw new Error(`[copy-wasm] package not installed: ${pkgRel} (run npm install first)`)
  }
  for (const c of candidates) {
    const p = join(pkgDir, c)
    if (existsSync(p)) return p
  }
  if (scanRe) {
    const found = scanFor(pkgDir, scanRe)
    if (found) return found
  }
  throw new Error(
    `[copy-wasm] could not locate ${candidates.join(' or ')} inside ${pkgRel}`,
  )
}

const jobs = [
  {
    from: findInPackage('@ffmpeg/core', ['dist/umd/ffmpeg-core.js', 'dist/esm/ffmpeg-core.js'], /ffmpeg-core\.js$/),
    to: join(outRoot, 'ffmpeg', 'core', 'ffmpeg-core.js'),
  },
  {
    from: findInPackage('@ffmpeg/core', ['dist/umd/ffmpeg-core.wasm', 'dist/esm/ffmpeg-core.wasm'], /ffmpeg-core\.wasm$/),
    to: join(outRoot, 'ffmpeg', 'core', 'ffmpeg-core.wasm'),
  },
  {
    from: findInPackage('@ffmpeg/core-mt', ['dist/umd/ffmpeg-core.js', 'dist/esm/ffmpeg-core.js'], /ffmpeg-core\.js$/),
    to: join(outRoot, 'ffmpeg', 'core-mt', 'ffmpeg-core.js'),
  },
  {
    from: findInPackage('@ffmpeg/core-mt', ['dist/umd/ffmpeg-core.wasm', 'dist/esm/ffmpeg-core.wasm'], /ffmpeg-core\.wasm$/),
    to: join(outRoot, 'ffmpeg', 'core-mt', 'ffmpeg-core.wasm'),
  },
  {
    from: findInPackage('@ffmpeg/core-mt', ['dist/umd/ffmpeg-core.worker.js', 'dist/esm/ffmpeg-core.worker.js'], /ffmpeg-core\.worker\.js$/),
    to: join(outRoot, 'ffmpeg', 'core-mt', 'ffmpeg-core.worker.js'),
  },
  {
    from: findInPackage('essentia.js', ['dist/essentia-wasm.web.js'], /essentia-wasm\.web\.js$/),
    to: join(outRoot, 'essentia', 'essentia-wasm.web.js'),
  },
  {
    from: findInPackage('essentia.js', ['dist/essentia-wasm.web.wasm'], /essentia-wasm\.web\.wasm$/),
    to: join(outRoot, 'essentia', 'essentia-wasm.web.wasm'),
  },
]

let copied = 0
for (const job of jobs) {
  ensureDir(dirname(job.to))
  copyFileSync(job.from, job.to)
  // eslint-disable-next-line no-console
  console.log(`[copy-wasm] ${relative(projectRoot, job.from)} -> ${relative(projectRoot, job.to)}`)
  copied += 1
}

// eslint-disable-next-line no-console
console.log(`[copy-wasm] done — copied ${copied} WASM asset(s) to public/wasm`)
