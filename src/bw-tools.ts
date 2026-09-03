/**
 * Model-facing Bitwarden CLI tools for the Prime Orchestrator plugin.
 *
 * This plugin contributes read-only tools that wrap the local `bw` CLI:
 * `bw_status` (vault status), `bw_list` (search/list vault objects), and
 * `bw_get` (retrieve one object or field). It owns no state; every call
 * resolves the Bitwarden session key through the host credential seam
 * (`ctx.credentials`) so a rotated credential reaches the next call without
 * a restart. Write operations (create, edit, delete, share) are intentionally
 * omitted from the model-facing surface.
 * @module dsh-prime-orchestrator/bw-tools
 */

import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, JsonValue } from '@deepseek-ai/dsh-tools'

export const name = 'bw-tools'

/** Hard service dependencies: the tool registry and the credential seam. */
export const inject = ['tools', 'credentials']

/** Credential-reference env name resolved for the Bitwarden session key. */
const DEFAULT_SESSION_ENV = 'BW_SESSION'

/** CLI path. */
const DEFAULT_CLI = 'bw'

/** Default per-command timeout. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Bound for rendered text blocks. */
const RENDER_CHAR_LIMIT = 12_000

/** Vault objects `bw list` can enumerate. */
const LIST_OBJECTS = [
  'items', 'folders', 'collections', 'organizations',
  'org-collections', 'org-members',
] as const

/** Get targets `bw get` can retrieve. */
const GET_OBJECTS = [
  'item', 'username', 'password', 'uri', 'totp', 'notes',
  'exposed', 'folder', 'collection', 'org-collection',
  'organization', 'template', 'fingerprint',
] as const

/** Plugin config: session credential reference, CLI path, timeout. */
export interface Config {
  /** Credential-reference env name holding the `bw` session key. */
  sessionEnv?: string
  /** Path to the `bw` executable; default `bw` (resolved from PATH). */
  cliPath?: string
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  sessionEnv: z.string().min(1).default(DEFAULT_SESSION_ENV),
  cliPath: z.string().min(1).default(DEFAULT_CLI),
  timeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(DEFAULT_TIMEOUT_MS),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bound one text with a shared ellipsis marker. */
function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text
}

/** Build a joined error message from a thrown or rejected value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/** Parse `bw` JSON output; pass through raw text when JSON parsing fails. */
export function parseOutput(text: string): { ok: true; value: JsonValue } | { ok: false; text: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(trimmed) as JsonValue }
  } catch {
    return { ok: false, text: trimmed }
  }
}

/** Resolve the session key through the credential seam, returning undefined when absent. */
async function resolveSession(ctx: Context, sessionEnv: string): Promise<string | undefined> {
  const resolved = await ctx.credentials.resolve(credentialRef(sessionEnv))
  return resolved?.value
}

/** Require a session for operations that read vault contents. */
function requireSession(session: string | undefined, sessionEnv: string): string {
  if (session === undefined) {
    throw new Error(`bw-tools: MISSING_CREDENTIAL — ${sessionEnv} is not set: store a Bitwarden session key under the ${sessionEnv} credential reference (run "bw unlock" to obtain one)`)
  }
  return session
}

/**
 * Run one `bw` subcommand with `--raw` JSON output.
 * @param cliPath - path or name of the `bw` executable.
 * @param session - Bitwarden session key, or undefined for unauthenticated commands like `status`.
 * @param args - subcommand arguments (e.g. ['status']).
 * @param timeoutMs - command timeout.
 * @param signal - caller cancellation signal.
 * @returns parsed JSON output, or raw text if `bw` emitted non-JSON.
 */
export function runBw(
  cliPath: string,
  session: string | undefined,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const bwArgs = [...args, '--raw']
  if (session !== undefined) bwArgs.push('--session', session)
  return new Promise((resolve, reject) => {
    const child = execFile(
      cliPath,
      bwArgs,
      { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || errorMessage(err)
          reject(new Error(`bw ${args.join(' ')}: ${detail}`))
          return
        }
        const parsed = parseOutput(stdout)
        resolve(parsed.ok ? parsed.value : (parsed.text as JsonValue))
      },
    )
    child.on('error', (err: Error) => reject(new Error(`bw ${args.join(' ')}: ${errorMessage(err)}`)))
  })
}

/** Validate `bw_get` arguments and normalize them into CLI args. */
export function makeGetArgs(args: unknown): { object: string; id: string; raw: boolean } {
  if (!isRecord(args)) throw new Error('bw_get: arguments must be an object')
  if (typeof args.object !== 'string' || !(GET_OBJECTS as readonly string[]).includes(args.object)) {
    throw new Error(`bw_get: "object" must be one of: ${GET_OBJECTS.join(', ')}`)
  }
  if (typeof args.id !== 'string' || args.id.trim() === '') {
    throw new Error('bw_get: "id" is required and must be a non-empty string')
  }
  if (args.raw !== undefined && typeof args.raw !== 'boolean') {
    throw new Error('bw_get: "raw" must be a boolean when provided')
  }
  return { object: args.object, id: args.id.trim(), raw: args.raw === true }
}

/** Validate `bw_list` arguments and normalize them into CLI args. */
export function makeListArgs(args: unknown): { object: string; search?: string; folderid?: string; collectionid?: string; trash?: boolean } {
  if (!isRecord(args)) throw new Error('bw_list: arguments must be an object')
  if (typeof args.object !== 'string' || !(LIST_OBJECTS as readonly string[]).includes(args.object)) {
    throw new Error(`bw_list: "object" must be one of: ${LIST_OBJECTS.join(', ')}`)
  }
  for (const key of ['search', 'folderid', 'collectionid'] as const) {
    const value = args[key]
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`bw_list: "${key}" must be a non-empty string when provided`)
    }
  }
  if (args.trash !== undefined && typeof args.trash !== 'boolean') {
    throw new Error('bw_list: "trash" must be a boolean when provided')
  }
  return {
    object: args.object,
    search: args.search as string | undefined,
    folderid: args.folderid as string | undefined,
    collectionid: args.collectionid as string | undefined,
    trash: args.trash as boolean | undefined,
  }
}

/** Render any BW result as bounded pretty JSON. */
export function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: bounded(text, RENDER_CHAR_LIMIT) }]
}

/**
 * Register the read-only Bitwarden CLI tools.
 * @param ctx - Cordis context carrying the host `tools` and `credentials` services.
 * @param config - resolved config (sessionEnv, cliPath, timeoutMs).
 */
export function apply(ctx: Context, config: Config): void {
  const sessionEnv = config.sessionEnv ?? DEFAULT_SESSION_ENV
  const cliPath = config.cliPath ?? DEFAULT_CLI
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  ctx.tools.register(defineTool({
    name: 'bw_status',
    description: 'Check the Bitwarden vault status (server, last sync, user, lock state) via the local bw CLI.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const session = await resolveSession(ctx, sessionEnv)
      return runBw(cliPath, session, ['status'], timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bw_list',
    description: 'List or search vault objects (items, folders, collections, organizations, org-collections, org-members) via the local bw CLI. Use bw_get to retrieve a specific object.',
    parameters: {
      object: {
        type: 'string',
        required: true,
        enum: LIST_OBJECTS,
        description: `The vault object type to list: ${LIST_OBJECTS.join(', ')}.`,
      },
      search: {
        type: 'string',
        description: 'Free-text search filter over the list results.',
      },
      folderid: {
        type: 'string',
        description: 'Filter items by folder id.',
      },
      collectionid: {
        type: 'string',
        description: 'Filter items by collection id.',
      },
      trash: {
        type: 'boolean',
        description: 'Include soft-deleted items.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeListArgs(args)
      const session = requireSession(await resolveSession(ctx, sessionEnv), sessionEnv)
      const bwArgs = ['list', a.object]
      if (a.search) bwArgs.push('--search', a.search)
      if (a.folderid) bwArgs.push('--folderid', a.folderid)
      if (a.collectionid) bwArgs.push('--collectionid', a.collectionid)
      if (a.trash) bwArgs.push('--trash')
      return runBw(cliPath, session, bwArgs, timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bw_get',
    description: 'Retrieve one Bitwarden vault object or field (item, username, password, uri, totp, notes, folder, collection, organization, etc.) by id or search term via the local bw CLI.',
    parameters: {
      object: {
        type: 'string',
        required: true,
        enum: GET_OBJECTS,
        description: `The object or field type to get: ${GET_OBJECTS.join(', ')}.`,
      },
      id: {
        type: 'string',
        required: true,
        description: 'The object id or search term. Use bw_list to find ids.',
      },
      raw: {
        type: 'boolean',
        description: 'Return the raw stored value for text fields (passwords, notes) instead of the usual JSON envelope.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeGetArgs(args)
      const session = requireSession(await resolveSession(ctx, sessionEnv), sessionEnv)
      const bwArgs = ['get', a.object, a.id]
      if (a.raw) bwArgs.push('--raw')
      return runBw(cliPath, session, bwArgs, timeoutMs, exec.signal)
    },
  }))
}
