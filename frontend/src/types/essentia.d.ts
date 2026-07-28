// Minimal type shim for essentia.js.
//
// essentia.js ships no first-class TypeScript types in the version we use.
// Rather than rely on an ambient `declare module` (which TypeScript ignores
// once the package resolves to a real JS file in node_modules), this file IS
// mapped to the bare specifier `essentia.js` via tsconfig `paths`, so every
// `import('essentia.js')` type-checks against the surface declared here.
//
// All algorithmic return values are intentionally `any` — the exact output
// field names (`beats` / `ticks` / `confidence`) are read defensively at
// runtime in `beatDetect.ts`.

/** A live essentia.js instance (Emscripten module + algorithm wrappers). */
export type EssentiaInstance = any

/** Constructor for the Essentia wrapper. Accepts the WASM module factory. */
export type EssentiaConstructor = new (
  wasm: ((opts: Record<string, unknown>) => unknown) | unknown,
  isDebug?: boolean,
  kWorkspace?: unknown,
) => EssentiaInstance

/** Named export used by the loader. */
export const Essentia: EssentiaConstructor
/** Package version (if present). */
export const version: string

export default { Essentia, version }
