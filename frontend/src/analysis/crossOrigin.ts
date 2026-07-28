/**
 * Cross-origin isolation capability detection.
 *
 * The multi-thread build of ffmpeg.wasm relies on `SharedArrayBuffer`, which
 * browsers only expose when the document is *cross-origin isolated* — i.e.
 * served with both `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` (see `public/_headers`). When
 * isolated we can load the faster multi-thread ffmpeg core; otherwise we
 * transparently fall back to the single-thread core (slower but universally
 * compatible — e.g. iOS Safari, or any static host without the COOP/COEP
 * headers). `essentia.js` is single-threaded WASM and works in both modes.
 */

/** True when the current document is cross-origin isolated (SAB available). */
export function isCrossOriginIsolatedFlag(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
}

/** True when we can use the multi-thread ffmpeg.wasm core. */
export function isMultithread(): boolean {
  return isCrossOriginIsolatedFlag() && typeof SharedArrayBuffer !== 'undefined'
}

/**
 * Best-effort detection of a desktop browser. Mobile browsers (especially iOS
 * Safari) have limited WASM / SharedArrayBuffer support, so the upload page
 * shows a "use a desktop browser" advisory. This is only a soft hint — the
 * analysis itself still attempts to run everywhere.
 */
export function isLikelyDesktop(): boolean {
  if (typeof navigator === 'undefined') return true
  const ua = navigator.userAgent || ''
  const mobileRe = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i
  const isIPad =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  return !mobileRe.test(ua) && !isIPad
}
