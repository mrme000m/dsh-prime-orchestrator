/**
 * Model-facing Bitwarden CLI tools for the Prime Orchestrator plugin.
 *
 * This plugin contributes read-only tools that wrap the local `bw` CLI:
 * `bw_accounts` (registered accounts + lock state), `bw_use` (switch the
 * active account), `bw_status` (vault status), `bw_list` (search/list vault
 * objects), and `bw_get` (retrieve one object or field). It owns no state;
 * every call resolves the active account's session key through the host
 * credential seam (`ctx.credentials`) so a rotated credential reaches the
 * next call without a restart.
 *
 * ## Multi-account
 *
 * The `bw` CLI keeps one active account per data directory and has no
 * switch-account subcommand, so accounts are isolated by data directory
 * (`BITWARDENCLI_APPDATA_DIR`, default the CLI's own) and selected per
 * operation: an optional `account` argument on every tool names a
 * registered account, and `bw_use` changes the default for subsequent
 * calls. Session keys are per-account credential references derived from
 * each account's `sessionEnv` (e.g. `BW_SESSION_WORK`), following the
 * credential seam doctrine: configuration carries references, never values.
 *
 * Write operations (create, edit, delete, share) are intentionally omitted
 * from the model-facing surface.
 * @module dsh-prime-orchestrator/bw-tools
 */

import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

export const name = 'bw-tools'

/** Hard service dependencies: the tool registry and the credential seam. */
export const inject = ['tools', 'credentials']

/** Default active account name when `defaultAccount` is not configured. */
const DEFAULT_ACCOUNT = 'default'

/** Credential-reference env name for the unnamed default account. */
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

/** One registered Bitwarden account. */
export interface BwAccount {
  /** Credential-reference env name holding this account's session key. */
  sessionEnv: string
  /**
   * Per-account CLI data directory, passed to the child as
   * `BITWARDENCLI_APPDATA_DIR` so accounts stay isolated; absent means the
   * CLI's own default directory (the single-account layout).
   */
  dataDir?: string
}

/** Plugin config: accounts, default account, CLI path, timeout. */
export interface Config {
  /** Registered accounts by name. The `default` entry is always present. */
  accounts: Record<string, BwAccount>
  /** Account name used when a tool call omits `account`; default `default`. */
  defaultAccount: string
  /** Path to the `bw` executable; default `bw` (resolved from PATH). */
  cliPath?: string
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number
}

/** One resolved account: config plus the name it was registered under. */
export interface ResolvedAccount extends BwAccount {
  /** Registration name of this account. */
  account: string
}

const accountSchema = z.object({
  sessionEnv: z.string().min(1),
  dataDir: z.string().min(1),
})

export const Config: z<Config> = z.object({
  accounts: z.dict(accountSchema).default({}),
  defaultAccount: z.string().min(1).default(DEFAULT_ACCOUNT),
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

/**
 * Resolve one account by name against the config, failing loud on unknowns.
 *
 * With no `accounts` configured, one implicit entry named `default` carries
 * the plugin's original `BW_SESSION` reference and the CLI's own data
 * directory — the single-account layout. An explicit `accounts.default`
 * entry replaces it wholesale.
 * @param config - resolved plugin config.
 * @param name - account name from a tool call, or the configured default.
 * @returns the account config with its registration name.
 */
export function resolveAccount(config: Config, name: string | undefined): ResolvedAccount {
  const wanted = (name ?? '').trim() || config.defaultAccount
  const registry: Record<string, BwAccount> = Object.keys(config.accounts).length > 0
    ? config.accounts
    : { [DEFAULT_ACCOUNT]: { sessionEnv: DEFAULT_SESSION_ENV } }
  const account = registry[wanted]
  if (account === undefined) {
    throw new Error(
      `bw-tools: UNKNOWN_ACCOUNT — "${wanted}" is not a registered account. Registered: ${Object.keys(registry).join(', ')}. Use bw_accounts to list them.`,
    )
  }
  return { account: wanted, ...account }
}

/**
 * Normalize an `account` argument from a tool call.
 * @param args - raw tool arguments.
 * @returns the trimmed account name, or undefined when absent/blank.
 */
export function readAccountArg(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const value = args['account']
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('bw-tools: account must be a string')
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Resolve the session key through the credential seam, returning undefined when absent. */
async function resolveSession(ctx: Context, sessionEnv: string): Promise<string | undefined> {
  const resolved = await ctx.credentials.resolve(credentialRef(sessionEnv))
  return resolved?.value
}

/** Require a session for operations that read vault contents. */
function requireSession(session: string | undefined, sessionEnv: string, account: string): string {
  if (session === undefined) {
    throw new Error(`bw-tools: MISSING_CREDENTIAL — ${sessionEnv} is not set: store the account "${account}" session key under the ${sessionEnv} credential reference (run "bw unlock" with that account active to obtain one)`)
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
 * @param dataDir - per-account `BITWARDENCLI_APPDATA_DIR`, or undefined for the CLI default.
 * @returns parsed JSON output, or raw text if `bw` emitted non-JSON.
 */
export function runBw(
  cliPath: string,
  session: string | undefined,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  dataDir?: string,
): Promise<JsonValue> {
  const bwArgs = [...args, '--raw']
  if (session !== undefined) bwArgs.push('--session', session)
  const env = dataDir === undefined ? undefined : { ...process.env, BITWARDENCLI_APPDATA_DIR: dataDir }
  return new Promise((resolve, reject) => {
    const child = execFile(
      cliPath,
      bwArgs,
      { timeout: timeoutMs, ...(signal ? { signal } : {}), ...(env ? { env } : {}) },
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
  if (!isRecord(args)) throw new Error('bw-tools: arguments must be an object')
  const object = args['object']
  if (typeof object !== 'string' || !GET_OBJECTS.includes(object as (typeof GET_OBJECTS)[number])) {
    throw new Error(`bw-tools: object must be one of ${GET_OBJECTS.join(', ')}`)
  }
  const id = args['id']
  if (typeof id !== 'string' || id.trim() === '') throw new Error('bw-tools: id must be a non-empty string')
  const raw = args['raw']
  if (raw !== undefined && typeof raw !== 'boolean') throw new Error('bw-tools: raw must be a boolean')
  return { object, id: id.trim(), raw: raw === true }
}

/** Validate `bw_list` arguments and normalize them into CLI args. */
export function makeListArgs(args: unknown): { object: string; search?: string; folderid?: string; collectionid?: string; trash?: boolean } {
  if (!isRecord(args)) throw new Error('bw-tools: arguments must be an object')
  const object = args['object']
  if (typeof object !== 'string' || !LIST_OBJECTS.includes(object as (typeof LIST_OBJECTS)[number])) {
    throw new Error(`bw-tools: object must be one of ${LIST_OBJECTS.join(', ')}`)
  }
  const takeString = (key: string): string | undefined => {
    const value = args[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`bw-tools: ${key} must be a non-empty string`)
    return value.trim()
  }
  const trash = args['trash']
  if (trash !== undefined && typeof trash !== 'boolean') throw new Error('bw-tools: trash must be a boolean')
  return {
    object,
    search: takeString('search'),
    folderid: takeString('folderid'),
    collectionid: takeString('collectionid'),
    trash: trash === true ? true : undefined,
  }
}

/** Render any BW result as bounded pretty JSON. */
export function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: bounded(JSON.stringify(value, null, 2), RENDER_CHAR_LIMIT) }]
}

/**
 * Register the read-only Bitwarden CLI tools with multi-account support.
 * @param ctx - Cordis context carrying the host `tools` and `credentials` services.
 * @param config - resolved config (accounts, defaultAccount, cliPath, timeoutMs).
 */
export function apply(ctx: Context, config: Config): void {
  const cliPath = config.cliPath ?? DEFAULT_CLI
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  /** Account name `bw_use` last selected; undefined means the row default. */
  let selectedAccount: string | undefined

  const accountParam: { type: 'string'; description: string } = {
    type: 'string',
    description: 'Account to operate on (see bw_accounts); defaults to the active account set by bw_use or the row default.',
  }

  ctx.tools.register(defineTool({
    name: 'bw_accounts',
    description: 'List the registered Bitwarden accounts, the active account, and each account\'s lock state (needs its session credential only to report "unlocked"). Use bw_use to switch the active account.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute() {
      const registry: Record<string, BwAccount> = Object.keys(config.accounts).length > 0
        ? config.accounts
        : { [DEFAULT_ACCOUNT]: { sessionEnv: DEFAULT_SESSION_ENV } }
      const active = selectedAccount ?? config.defaultAccount
      const entries = await Promise.all(Object.entries(registry).map(async ([name, account]) => {
        const status = await runBw(cliPath, undefined, ['status'], timeoutMs, undefined, account.dataDir).catch((err: unknown) => errorMessage(err))
        const record = isRecord(status) ? status : {}
        return {
          account: name,
          active: name === active,
          sessionEnv: account.sessionEnv,
          dataDir: account.dataDir ?? null,
          status: record['status'] ?? 'unknown',
          userEmail: record['userEmail'] ?? null,
          serverUrl: record['serverUrl'] ?? null,
        }
      }))
      return { accounts: entries }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bw_use',
    description: 'Switch the active Bitwarden account for subsequent bw_* tool calls (bw_status, bw_list, bw_get). The choice persists for this session; list accounts with bw_accounts.',
    parameters: {
      account: {
        type: 'string',
        required: true,
        description: 'Account name to make active (see bw_accounts).',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const account = resolveAccount(config, readAccountArg(args))
      selectedAccount = account.account
      return { account: account.account, sessionEnv: account.sessionEnv }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bw_status',
    description: 'Check the active Bitwarden account\'s vault status (server, last sync, user, lock state) via the local bw CLI. List or switch accounts with bw_accounts / bw_use.',
    parameters: { account: accountParam },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const account = resolveAccount(config, readAccountArg(args) ?? selectedAccount)
      const session = await resolveSession(ctx, account.sessionEnv)
      return runBw(cliPath, session, ['status'], timeoutMs, exec.signal, account.dataDir)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bw_list',
    description: 'List or search vault objects (items, folders, collections, organizations, org-collections, org-members) of the active account via the local bw CLI. Use bw_get to retrieve a specific object; bw_accounts / bw_use to switch account.',
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
      account: accountParam,
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeListArgs(args)
      const account = resolveAccount(config, readAccountArg(args) ?? selectedAccount)
      const session = requireSession(await resolveSession(ctx, account.sessionEnv), account.sessionEnv, account.account)
      const bwArgs = ['list', a.object]
      if (a.search) bwArgs.push('--search', a.search)
      if (a.folderid) bwArgs.push('--folderid', a.folderid)
      if (a.collectionid) bwArgs.push('--collectionid', a.collectionid)
      if (a.trash) bwArgs.push('--trash')
      return runBw(cliPath, session, bwArgs, timeoutMs, exec.signal, account.dataDir)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bw_get',
    description: 'Retrieve one Bitwarden vault object or field (item, username, password, uri, totp, notes, folder, collection, organization, etc.) by id or search term from the active account via the local bw CLI. Use bw_list to find ids; bw_accounts / bw_use to switch account.',
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
      account: accountParam,
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const a = makeGetArgs(args)
      const account = resolveAccount(config, readAccountArg(args) ?? selectedAccount)
      const session = requireSession(await resolveSession(ctx, account.sessionEnv), account.sessionEnv, account.account)
      const bwArgs = ['get', a.object, a.id]
      if (a.raw) bwArgs.push('--raw')
      return runBw(cliPath, session, bwArgs, timeoutMs, exec.signal, account.dataDir)
    },
  }))
}
