/**
 * Startup materialization of the `prime-orchestrator` agent preset.
 *
 * The preset cannot ship through dsh's shipped-preset root (that belongs to
 * the stock `dsh-agent-presets` package), so this package carries the
 * composition under `presets/prime-orchestrator/` and copies it into the
 * first user-trust preset root at boot — the same root the roster's
 * authoring flow writes, re-scanned on every `list()`, so a preset that
 * appears while the process runs is visible immediately.
 *
 * A `.plugin-managed.json` marker keeps ownership honest:
 *   - untouched tree → an updated package re-materializes in place;
 *   - untouched and current → idle: no writes, no output;
 *   - user-edited tree (any hash mismatch) → never touched again, on startup
 *     or on disposal — delete the directory to re-materialize;
 *   - a directory without the marker was authored by someone else → left
 *     alone entirely.
 *
 * Uninstall hygiene: on disposal, a package directory that still exists means
 * reload/update/restart — keep the preset; a vanished package.json means
 * uninstall — remove the preset, but only if the user never modified it.
 * @module dsh-prime-orchestrator/preset
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Preset id: also the directory name inside the user root. */
const PRESET_ID = 'prime-orchestrator'
/** Marker filename recording every file hash this package wrote. */
const MARKER_FILE = '.plugin-managed.json'
/** Directory where this module's package root lives (src/ and lib/ sit one level below it). */
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
/** The committed preset payload inside this package. */
const SOURCE = join(pkgDir, 'presets', PRESET_ID)

/** Every file under `root`, as sorted relative POSIX-style paths. */
function walkFiles(root: string, rel = ''): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkFiles(root, r))
    else if (e.isFile()) out.push(r)
  }
  return out.sort()
}

/** Map of relative path → sha256 for every file under `root`, marker excluded. */
function hashTree(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const rel of walkFiles(root)) {
    if (rel === MARKER_FILE) continue
    files[rel] = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
  }
  return files
}

/** The parsed marker, or null when the tree is not ours. */
function readMarker(target: string): { managedBy: string; files: Record<string, string>; version: string } | null {
  try {
    const m = JSON.parse(readFileSync(join(target, MARKER_FILE), 'utf8'))
    if (m && m.managedBy === 'dsh-prime-orchestrator' && m.files && typeof m.files === 'object') return m
  } catch {
    /* absent or unreadable → not ours */
  }
  return null
}

/** Classify the preset directory against this package: absent, foreign, user-modified, or unmodified. */
function classify(target: string): 'absent' | 'foreign' | 'user-modified' | 'unmodified' {
  if (!existsSync(target)) return 'absent'
  const marker = readMarker(target)
  if (marker === null) return 'foreign'
  const current = hashTree(target)
  const recorded = marker.files
  const keys = Object.keys(recorded)
  if (keys.length !== Object.keys(current).length) return 'user-modified'
  for (const k of keys) if (current[k] !== recorded[k]) return 'user-modified'
  return 'unmodified'
}

/** This package's own version, for the marker's idle check. */
function packageVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** The first user-trust root the roster exposes, or the default user root when no roster is mounted. */
function userPresetRoot(ctx: Context): string {
  const roster = ctx.get('agentPresets') as { roots?: readonly { path: string; trust: string }[] } | undefined
  const roots = roster?.roots ?? []
  const first = roots.find(root => root.trust === 'user')
  return first?.path ?? dshHomePath('.agent-presets')
}

/** Remove the preset on a true uninstall; keep it across reload, update, and restart. */
function cleanupOnDispose(target: string): void {
  if (!existsSync(target)) return
  const uninstalled = !existsSync(join(pkgDir, 'package.json'))
  const modified = classify(target) !== 'unmodified'
  if (uninstalled && !modified) rmSync(target, { recursive: true, force: true })
}

/**
 * Materialize the preset once per boot: copy `presets/prime-orchestrator/`
 * into the user root, guarded by the sha256 marker. Failures degrade to a
 * logged line — a broken materialization must never take the host row down,
 * because the engine works without the preset (the tool simply is not
 * composed until a session names the preset).
 * @param ctx - Cordis context of the mounting row.
 */
export function materializePresetOnBoot(ctx: Context): void {
  try {
    const target = join(userPresetRoot(ctx), PRESET_ID)
    const state = classify(target)
    const version = packageVersion()

    if (state === 'foreign') {
      console.warn('[prime-orchestrator] a preset not written by this package already exists '
        + `at ${target} — leaving it alone`)
      return
    }
    if (state === 'user-modified') {
      console.warn('[prime-orchestrator] preset at '
        + `${target} was modified after materialization — keeping the user's version `
        + '(delete the directory to re-materialize)')
      return
    }

    ctx.effect(() => () => cleanupOnDispose(target), 'prime-orchestrator: preset materialization')

    const marker = readMarker(target)
    if (state === 'unmodified' && marker !== null && marker.version === version) return

    if (!statSync(SOURCE).isDirectory()) {
      console.warn(`[prime-orchestrator] preset payload missing from the package (${SOURCE}) — skipped`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    cpSync(SOURCE, target, { recursive: true })
    const files = hashTree(target)
    writeFileSync(join(target, MARKER_FILE), `${JSON.stringify({ managedBy: 'dsh-prime-orchestrator', version, files }, null, 2)}\n`)
  } catch (error) {
    console.warn('[prime-orchestrator] preset materialization failed:', error instanceof Error ? error.message : String(error))
  }
}
