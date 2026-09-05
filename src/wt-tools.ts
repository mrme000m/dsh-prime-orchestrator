/**
 * Model-facing WunderTrading tools for the Prime Orchestrator plugin.
 *
 * This plugin contributes the `wt-*` tool family wrapping the bundled
 * `bin/wt.mjs` CLI: `wt_status` (browser/bdg/vault/API state), `wt_session`
 * (check/save/load/restore), `wt_login` (headful CloakBrowser login flow with
 * cookies persisted to the Bitwarden vault), `wt_browse` (navigate the
 * session-authenticated dashboard), `wt_api` (signed HMAC REST calls under
 * /open_api), `wt_apikey` (list/create API keys), and `wt_mcp` (official MCP
 * server client config). It owns no state: every call resolves the Bitwarden
 * session key through the host credential seam (`ctx.credentials`) so a
 * rotated credential reaches the next call without a restart, and the CLI
 * itself reads WunderTrading credentials only from env/vault — secrets never
 * appear in tool arguments. It also registers the bundled `wt-network` skill.
 * @module dsh-prime-orchestrator/wt-tools
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
// Type-only: merges `Context.skills` for the runtime skill registration.
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'wt-tools'

/** Hard service dependencies: tool registry, credential seam, skill registry. */
export const inject = ['tools', 'credentials', 'skills']

/** Credential-reference env name resolved for the Bitwarden session key. */
const DEFAULT_SESSION_ENV = 'BW_SESSION'

/** Default CloakBrowser workspace dir (launch.mjs + bdg live inside). */
const DEFAULT_CLOAK_DIR = '/Volumes/ExMac/code/tradingview/minimal-mjs'

/** Default per-command timeout: the headful login flow takes ~40s. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Bound for rendered text blocks. */
const RENDER_CHAR_LIMIT = 12_000

/** Vault item holding the full WunderTrading API key pair (never printed). */
const API_VAULT_ITEM = 'wundertrading-api'

/** `wt session` subcommands. */
const SESSION_ACTIONS = ['check', 'save', 'load', 'restore'] as const

/** HTTP methods the signed REST surface accepts. */
const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** `wt apikey` subcommands. */
const APIKEY_ACTIONS = ['list', 'create'] as const

/** Plugin config: CLI path, cloak dir, session credential reference, timeout. */
export interface Config {
  /** Path to the `wt.mjs` CLI; default the bundled `bin/wt.mjs`. */
  cliPath?: string
  /** CloakBrowser workspace dir exported to the child as `WT_CLOAK_DIR`. */
  cloakDir?: string
  /** Credential-reference env name holding the `bw` session key. */
  sessionEnv?: string
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  cliPath: z.string().min(1).default(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wt.mjs')),
  cloakDir: z.string().min(1).default(DEFAULT_CLOAK_DIR),
  sessionEnv: z.string().min(1).default(DEFAULT_SESSION_ENV),
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

/** Keep the trailing part of CLI output for error reporting. */
function tail(text: string, limit = 800): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed
}

/** Parse `wt` JSON output; pass through raw text when JSON parsing fails. */
export function parseOutput(text: string): { ok: true; value: JsonValue } | { ok: false; text: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(trimmed) as JsonValue }
  } catch {
    return { ok: false, text: trimmed }
  }
}

/**
 * Mask a secret for model-facing output: keep the first 4 and last 2
 * characters with `***` between. Values shorter than 8 characters (or not
 * usable strings) collapse to `***` so nothing identifiable leaks.
 */
export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-2)}`
}

/** Resolve the session key through the credential seam, returning undefined when absent. */
async function resolveSession(ctx: Context, sessionEnv: string): Promise<string | undefined> {
  const resolved = await ctx.credentials.resolve(credentialRef(sessionEnv))
  return resolved?.value
}

/**
 * Run one `wt` CLI subcommand and return its parsed JSON.
 *
 * The child gets `WT_CLOAK_DIR` from config and `BW_SESSION` from the
 * credential seam (empty when unresolved, which the CLI treats as absent —
 * this also shadows any stale parent-process value).
 * @param cliPath - path to the `wt.mjs` CLI.
 * @param session - Bitwarden session key, or undefined.
 * @param cloakDir - CloakBrowser workspace dir for the child env.
 * @param argv - CLI arguments (e.g. ['status', '--json']).
 * @param timeoutMs - command timeout.
 * @param signal - caller cancellation signal.
 * @returns parsed JSON output, or raw text if `wt` emitted non-JSON.
 */
export function runWt(
  cliPath: string,
  session: string | undefined,
  cloakDir: string,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const env = {
    ...process.env,
    BW_SESSION: session ?? '',
    WT_CLOAK_DIR: cloakDir,
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'node',
      [cliPath, ...argv],
      { timeout: timeoutMs, env, ...(signal ? { signal } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const detail = tail(stderr) || tail(stdout) || errorMessage(err)
          reject(new Error(`wt ${argv.join(' ')}: ${detail}`))
          return
        }
        const parsed = parseOutput(stdout)
        resolve(parsed.ok ? parsed.value : (parsed.text as JsonValue))
      },
    )
    child.on('error', (err: Error) => reject(new Error(`wt ${argv.join(' ')}: ${errorMessage(err)}`)))
  })
}

/** Validate `wt_status` arguments (the tool takes none). */
export function makeStatusArgs(args: unknown): Record<string, never> {
  if (!isRecord(args)) throw new Error('wt_status: arguments must be an object')
  const extra = Object.keys(args).filter((key) => key !== '')
  if (extra.length > 0) throw new Error(`wt_status: unexpected arguments: ${extra.join(', ')}`)
  return {}
}

/** Validate `wt_session` arguments and normalize the action. */
export function makeSessionArgs(args: unknown): { action: 'check' | 'save' | 'load' | 'restore' } {
  if (!isRecord(args)) throw new Error('wt_session: arguments must be an object')
  if (typeof args.action !== 'string' || !(SESSION_ACTIONS as readonly string[]).includes(args.action)) {
    throw new Error(`wt_session: "action" must be one of: ${SESSION_ACTIONS.join(', ')}`)
  }
  return { action: args.action as (typeof SESSION_ACTIONS)[number] }
}

/** Validate `wt_api` arguments and normalize them into CLI-ready form. */
export function makeApiArgs(args: unknown): { method: string; path: string; body?: string; recv?: number } {
  if (!isRecord(args)) throw new Error('wt_api: arguments must be an object')
  if (typeof args.method !== 'string' || !(API_METHODS as readonly string[]).includes(args.method.trim().toUpperCase())) {
    throw new Error(`wt_api: "method" must be one of: ${API_METHODS.join(', ')}`)
  }
  if (typeof args.path !== 'string' || !args.path.startsWith('/') || args.path.trim() === '') {
    throw new Error('wt_api: "path" is required and must be an absolute path starting with "/" (query string included)')
  }
  if (args.body !== undefined && (typeof args.body !== 'string' || args.body.trim() === '')) {
    throw new Error('wt_api: "body" must be a non-empty JSON string when provided')
  }
  if (args.recv !== undefined && (typeof args.recv !== 'number' || !Number.isInteger(args.recv) || args.recv <= 0)) {
    throw new Error('wt_api: "recv" must be a positive integer (recv-window in milliseconds) when provided')
  }
  return {
    method: args.method.trim().toUpperCase(),
    path: args.path,
    body: args.body as string | undefined,
    recv: args.recv as number | undefined,
  }
}

/** Validate `wt_apikey` arguments; `name` is required for create. */
export function makeApikeyArgs(args: unknown): { action: 'list' | 'create'; name?: string } {
  if (!isRecord(args)) throw new Error('wt_apikey: arguments must be an object')
  if (typeof args.action !== 'string' || !(APIKEY_ACTIONS as readonly string[]).includes(args.action)) {
    throw new Error(`wt_apikey: "action" must be one of: ${APIKEY_ACTIONS.join(', ')}`)
  }
  const action = args.action as (typeof APIKEY_ACTIONS)[number]
  if (args.name !== undefined && (typeof args.name !== 'string' || args.name.trim() === '')) {
    throw new Error('wt_apikey: "name" must be a non-empty string when provided')
  }
  if (args.action === 'create' && (typeof args.name !== 'string' || args.name.trim() === '')) {
    throw new Error('wt_apikey: "name" is required for action create')
  }
  return { action, name: (args.name as string | undefined)?.trim() }
}

/** Validate `wt_browse` arguments and normalize the optional URL. */
export function makeBrowseArgs(args: unknown): { url?: string } {
  if (!isRecord(args)) throw new Error('wt_browse: arguments must be an object')
  if (args.url !== undefined) {
    if (typeof args.url !== 'string' || args.url.trim() === '') {
      throw new Error('wt_browse: "url" must be a non-empty string when provided')
    }
    return { url: args.url.trim() }
  }
  return {}
}

/** Render any WT result as bounded pretty JSON. */
export function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: bounded(text, RENDER_CHAR_LIMIT) }]
}

/** Mask the one-time API secret in a `wt apikey create` result. */
function maskApikeyResult(value: JsonValue): JsonValue {
  if (!isRecord(value)) return value
  if (typeof value.apiSecret !== 'string' || value.apiSecret === '') return value
  return {
    ...value,
    apiSecret: maskSecret(value.apiSecret),
    note: `apiSecret is masked; the full value is in the Bitwarden vault item ${API_VAULT_ITEM} (shown only once at creation — never print it)`,
  }
}

/** Skill catalog description and routing guidance, kept beside the tool wording. */
const SKILL_DESCRIPTION = `Investigate and operate WunderTrading via the wt CLI: bdg + CloakBrowser headful web sessions, session cookies persisted in the Bitwarden vault, the HMAC-signed REST API under /open_api, and the official MCP server. Prefer the wt_* tools for status, login, session, API, and API-key work; use this skill for the command cookbook, verified selectors, and gotchas.`

const SKILL_WHEN_TO_USE = `When operating WunderTrading beyond a single wt_* tool call — running the login flow, diagnosing a dead session, choosing between web-UI automation / REST / MCP, creating or rotating API keys, or extending the wt CLI with a new UI flow or REST endpoint.`

/**
 * Register the WunderTrading CLI tools and the bundled `wt-network` skill.
 * @param ctx - Cordis context carrying the host `tools`, `credentials`, and `skills` services.
 * @param config - resolved config (cliPath, cloakDir, sessionEnv, timeoutMs).
 */
export function apply(ctx: Context, config: Config): void {
  const cliPath = config.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wt.mjs')
  const cloakDir = config.cloakDir ?? DEFAULT_CLOAK_DIR
  const sessionEnv = config.sessionEnv ?? DEFAULT_SESSION_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const skillPath = fileURLToPath(new URL('../skills/wt-network/SKILL.md', import.meta.url))
  const raw = readFileSync(skillPath, 'utf8')
  const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
  ctx.skills.register({
    name: 'wt-network',
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content,
    path: skillPath,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/wt-network/', import.meta.url)) },
    source: 'bundled',
  })

  ctx.tools.register(defineTool({
    name: 'wt_status',
    description: 'Check the WunderTrading stack state: headful CloakBrowser (running, CDP port, page URL), bdg attachment, web-session login, Bitwarden vault unlock + items, API key presence, and MCP URL. Run this first to decide what is needed.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      makeStatusArgs(args)
      const session = await resolveSession(ctx, sessionEnv)
      return runWt(cliPath, session, cloakDir, ['status', '--json'], timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wt_session',
    description: 'Manage the WunderTrading web session cookies (PHPSESSID + cf_clearance, persisted in the Bitwarden vault): check whether the dashboard is still logged in, save current browser cookies to the vault, load vault cookies into the browser, or restore (load + check).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: SESSION_ACTIONS,
        description: 'check: navigate a dashboard route and test for a login redirect; save: browser cookies → vault; load: vault cookies → browser; restore: load + check.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeSessionArgs(args)
      const session = await resolveSession(ctx, sessionEnv)
      return runWt(cliPath, session, cloakDir, ['session', a.action], timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wt_login',
    description: 'Run the verified headful CloakBrowser login flow on wundertrading.com and persist the session cookies to the Bitwarden vault. Credentials come from env (WT_EMAIL/WT_PASSWORD) or the vault item wundertrading-login — never from arguments. Takes ~40s.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const session = await resolveSession(ctx, sessionEnv)
      return runWt(cliPath, session, cloakDir, ['login'], timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wt_browse',
    description: 'Open a WunderTrading page in the headful stealth browser with the vault session cookies applied (dashboard landing by default), and report the CDP endpoint, page WebSocket URL, final URL, and login state. Use before driving the web UI with bdg.',
    parameters: {
      url: {
        type: 'string',
        description: 'Optional page to navigate to (defaults to the dashboard).',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeBrowseArgs(args)
      const session = await resolveSession(ctx, sessionEnv)
      const argv = a.url === undefined ? ['browse'] : ['browse', a.url]
      return runWt(cliPath, session, cloakDir, argv, timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wt_api',
    description: 'Call the WunderTrading REST API (HMAC-signed paths under /open_api): strategy listing/history/trade, market-enter, swing, cancel, market-close, api_profiles, exchanges, markets. Credentials come from env (WT_API_KEY/WT_API_SECRET) or the vault item wundertrading-api.',
    parameters: {
      method: {
        type: 'string',
        required: true,
        enum: API_METHODS,
        description: 'HTTP method.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Absolute API path starting with "/", query string included (e.g. /open_api/strategies/live).',
      },
      body: {
        type: 'string',
        description: 'Request body as a JSON string for POST/PUT/PATCH.',
      },
      recv: {
        type: 'integer',
        description: 'Recv-window in milliseconds (X-Recv-Window header).',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeApiArgs(args)
      const session = await resolveSession(ctx, sessionEnv)
      const argv = ['api', a.method, a.path]
      if (a.body !== undefined) argv.push('--body', a.body)
      if (a.recv !== undefined) argv.push('--recv', String(a.recv))
      return runWt(cliPath, session, cloakDir, argv, timeoutMs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wt_apikey',
    description: 'List WunderTrading API keys (name, masked key, IP, expiry, permissions) or create a new key pair via the web UI. Create shows the secret exactly once; the tool masks it and stores the full pair in the Bitwarden vault item wundertrading-api.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: APIKEY_ACTIONS,
        description: 'list: scrape the /en/trader/open_api key table; create: run the verified creation flow.',
      },
      name: {
        type: 'string',
        description: 'Key name (required for create).',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeApikeyArgs(args)
      const session = await resolveSession(ctx, sessionEnv)
      const argv = a.action === 'list' ? ['apikey', 'list'] : ['apikey', 'create', a.name as string]
      const value = await runWt(cliPath, session, cloakDir, argv, timeoutMs, exec.signal)
      return a.action === 'list' ? value : maskApikeyResult(value)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wt_mcp',
    description: 'Print masked MCP client configuration (cursor + vscode shapes) for the official WunderTrading MCP server at https://wundertrading.com:2083/mcp using the vault API key pair.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const session = await resolveSession(ctx, sessionEnv)
      return runWt(cliPath, session, cloakDir, ['mcp', 'config', '--mask'], timeoutMs, exec.signal)
    },
  }))
}
