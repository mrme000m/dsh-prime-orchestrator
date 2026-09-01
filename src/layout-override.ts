/**
 * Browser-side layout override delivery.
 *
 * The Prime fleet column needs a four-column shell ('prime' slot, live
 * across session switches), which stock dsh layouts do not ship. This package
 * carries a patched stock ui-layout bundle (lib/layout-override.js, built from
 * the stock sources plus the prime-column patch) and delivers it through two
 * host-side pieces:
 *
 * 1. An exact route `/prime/layout-override.js` serving the artifact (plus
 *    its source map). Exact routes win over the engine's `/prime` prefix.
 * 2. An index tap rewriting the boot manifest entry for
 *    '@deepseek-ai/dsh-client-ui-layout' to that URL, so the browser module
 *    system registers the patched factory instead of the stock one (factory
 *    registration is single-shot per id, so the stock bundle must never
 *    load — the rewrite, not a second registration, is the mechanism).
 *
 * Both registrations are optional: a composition without a web server, or a
 * future dsh whose layout already ships a 'prime' slot (the entry would then
 * be absent or already carry one), simply leaves the stock shell in place.
 * @module dsh-prime-orchestrator/layout-override
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges `Context.webServer` for the route/tap registrations.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The stock module this package overrides. */
const LAYOUT_MODULE = '@deepseek-ai/dsh-client-ui-layout'
/** Served override path under this package's /prime prefix. */
const OVERRIDE_PATH = '/prime/layout-override.js'

/** The built override artifact beside this module. */
const artifact = join(dirname(fileURLToPath(import.meta.url)), 'layout-override.js')

/** One-line identity for warnings (never per-request spam). */
const TAG = '[prime-orchestrator]'

/**
 * Serve the override artifact (and its source map) as one exact route.
 * @returns the route registration value for `webServer.register`, or undefined when the artifact is absent.
 */
export function layoutOverrideRoute(): { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void } | undefined {
  if (!existsSync(artifact)) return undefined
  return {
    kind: 'exact',
    path: OVERRIDE_PATH,
    handler: (req, res) => {
      const map = req.url?.endsWith('.map') === true
      const file = map ? `${artifact}.map` : artifact
      try {
        const size = statSync(file).size
        res.writeHead(200, {
          'content-type': map ? 'application/json' : 'application/javascript',
          'content-length': size,
          'cache-control': 'no-cache',
        })
        createReadStream(file).pipe(res)
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'layout override artifact missing' }))
      }
    },
  }
}

/**
 * Rewrite the boot manifest so the layout entry loads this package's
 * patched bundle: the module system's factory registration is single-shot
 * per id, so redirecting the entry URL (never a second registration) is the
 * supported way to replace one browser plugin's implementation.
 * @param html - the rendered index.html body.
 * @param version - this package's version, used as the cache-busting rev.
 * @returns the html with the layout entry's URL swapped, or the input unchanged on any mismatch.
 */
export function rewriteLayoutEntry(html: string, version: string): string {
  try {
    const marker = 'globalThis["__DSH_BOOT__"]'
    const at = html.indexOf(marker)
    if (at < 0) return html
    const start = html.indexOf('{', at)
    const end = html.indexOf('</script>', start)
    if (start < 0 || end < 0) return html
    const manifest = JSON.parse(html.slice(start, end).trim().replace(/;$/u, '')) as {
      entries?: Array<{ id?: unknown; url?: unknown }>
    }
    if (!Array.isArray(manifest.entries)) return html
    let replaced = false
    for (const entry of manifest.entries) {
      if (entry?.id !== LAYOUT_MODULE) continue
      if (typeof entry.url !== 'string' || !entry.url.startsWith('/plugins/')) return html
      entry.url = `${OVERRIDE_PATH}?rev=${encodeURIComponent(version)}`
      replaced = true
    }
    if (!replaced) return html
    const next = html.slice(0, start) + JSON.stringify(manifest) + html.slice(end)
    return next
  } catch (error) {
    console.warn(TAG, 'boot-manifest layout rewrite skipped:', error instanceof Error ? error.message : String(error))
    return html
  }
}

/**
 * Register the override route and the index tap on the web server service.
 * @param ctx - Cordis context of a composition exposing `webServer`.
 */
export function installLayoutOverride(ctx: Context): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const route = layoutOverrideRoute()
  if (route === undefined) {
    console.warn(TAG, 'layout override artifact missing — serving the stock three-column shell')
    return
  }
  ctx.effect(() => webServer.register(route), 'prime-orchestrator: layout override route')
  ctx.effect(
    () => webServer.tapIndex(html => rewriteLayoutEntry(html, packageVersion())),
    'prime-orchestrator: layout override tap',
  )
}

/** This package's own version (the tap's cache-busting rev), or '0' when unreadable. */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(artifact), '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : '0'
  } catch {
    return '0'
  }
}
