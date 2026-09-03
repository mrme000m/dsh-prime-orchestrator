/**
 * Host-plane Prime Orchestration service (`ctx.prime`).
 *
 * TypeScript port of the prime-orchestrator preset plugin's server half:
 * delegation lifecycle, one-shot CLI runs, the protocol-7 daemon socket
 * client, projections, and the `/prime` JSON API. The service owns the shared
 * delegation table and exit hook for a single host instance; the
 * `Symbol.for` process-global hack of the preset plugin is gone.
 *
 * The settings namespace `prime` and the `/prime` web prefix are optional:
 * without a settings provider or a web server the service still boots and
 * resolves its configuration from the row config plus schema defaults.
 * @module dsh-prime-orchestrator/engine
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: merges `Context.webServer` so the optional route registration types.
import type {} from '@deepseek-ai/dsh-host-webserver'

import type {
  PrimeAction,
  PrimeConfig,
  PrimeDelegateRequest,
  PrimeDelegation,
  PrimeGeneration,
  PrimeSessionFile,
  PrimeState,
  PrimeStopResult,
  ResolvedIdentity,
} from './types.ts'

export type {
  PrimeAction,
  PrimeConfig,
  PrimeDelegateRequest,
  PrimeDelegation,
  PrimeGeneration,
  PrimeGenerationStep,
  PrimeSessionFile,
  PrimeState,
  PrimeStopResult,
  ResolvedIdentity,
} from './types.ts'

/** One `spawn` child with stdin ignored and piped stdout/stderr. */
type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>

declare module '@deepseek-ai/cordis' {
  interface Context {
    prime: PrimeOrchestration
  }
}

/** Settings namespace owned by this service. */
export const SETTINGS_NAMESPACE = 'prime-orchestrator'

/** Row-config keys accepted by the service; every other key fails loud. */
const CONFIG_KEYS = new Set(['bin', 'stateDir', 'maxDelegations', 'daemonSocket'])

/** Row config after resolveConfig validation and defaulting. */
export interface Config {
  bin: string
  stateDir: string
  maxDelegations: number
  daemonSocket: string | null
}

/**
 * User-writable settings section layered over the row config. Flat by design,
 * mirroring the `ui-prime-settings` client form: empty string / `0` / `false`
 * mean "inherit the row-config default".
 */
interface PrimeSettings {
  enabled: boolean
  maxDelegations: number
  bin: string
  stateDir: string
  daemonSocket: string
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  delegateModel: string
  delegateProvider: string
  delegateThinking: string
  delegateGoalTokenBudget: number
  delegateAutonomous: boolean
  delegateAutonomousMaxContinuations: number
}

/** Internal delegation record: the public view plus live handles and buffers. */
interface DelegationRecord extends Omit<PrimeDelegation, 'completed'> {
  stderrFile: string
  sawAgentEnd: boolean
  child: SpawnedChild | null
  _lineBuffer: string
  _turnHasWrite: boolean
  _consecutiveReadOnly: number
}

/** One projected event summary. */
interface EventSummary {
  type: string
  role?: string
  text?: string
  toolCalls?: string[]
  goalState?: {
    status: string | null
    goalId: string | null
    active: boolean
    tokensUsed: number | null
    timeUsedSeconds: number | null
  }
  objective?: string
  customType?: string | null
  toolName?: string
  toolCallId?: string
  durationMs?: number | null
  toolStatus?: string | null
  compaction?: string
  taskState?: string | null
  needsInput?: boolean
}

/** Projected daemon agent roster row. */
export interface AgentView {
  id: string | null
  sessionId: string | null
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  firstMessage: string | null
  model: string | null
  modelId: string | null
  thinking: string | null
  lifecycle: string | null
  activity: string | null
  daemonBacked: boolean
  isSessionActive: boolean
  isStreaming: boolean
  isCompacting: boolean
  isBashRunning: boolean
  isRunningTools: boolean
  hasRunningRlmChildren: boolean
  messageCount: number
  unfinishedActionCount: number
  attachedClients: number
  taskState: string | null
  workerState: string | null
  rlmDepth: number
  parentSessionId: string | null
  hasRegisteredCronJob: boolean
  hasActiveHeartbeat: boolean
  nextRunAt: string | null
  created: string | null
  modified: string | null
  lastActivityAt: string | null
}

/** Projected saved-session row. */
interface SavedSessionView {
  id: string | null
  path: string | null
  cwd: string | null
  name: string | null
  state: string | null
  parentSessionPath: string | null
  rlmDepth: number
  created: string | null
  modified: string | null
  messageCount: number
  firstMessage: string | null
}

/** Projected heartbeat/cron job row. */
interface HeartbeatView {
  id: string | null
  status: string | null
  source: string | null
  runtimeKind: string | null
  deliveryMode: string | null
  activeSessionId: string | null
  sessionId: string | null
  scheduleKind: string | null
  schedule: string | null
  intervalMs: number | null
  label: string | null
  prompt: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  lastSkippedAt: string | null
  lastError: string | null
  runCount: number
  createdAt: string | null
  updatedAt: string | null
  sessionName: string | null
  firstMessage: string | null
}

/** One-shot CLI result. */
interface CliResult {
  ok: boolean
  code: number | null
  output: string
}

/** Daemon socket request result. */
type DaemonResult =
  | { ok: true; data: unknown }
  | { ok: false; output: string }

/** Roster result: either the CLI failure or the projected agents. */
export type ListAgentsResult =
  | { ok: false; output: string }
  | { ok: true; agents: AgentView[] }

/** Heartbeat catalog result: either the daemon failure or the projected jobs. */
type HeartbeatsResult =
  | { ok: false; output: string }
  | { ok: true; jobs: HeartbeatView[] }

/** Listing of prime-agent's own persisted sessions. */
interface PrimeSessionsListing {
  dir: string
  sessions: PrimeSessionFile[]
}

/** On-demand session inspection result. */
interface SessionInspection {
  id: string
  file: string
  sizeBytes: number
  modifiedAt: string
  goal: EventSummary['goalState'] | null
  goalContext: string | null
  lastSlashCommandResult: string | null
  lastCompaction: string | null
  idle: boolean
  lastActivityType: string | null
  events: EventSummary[]
}

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-array object, or an empty record for anything else (robust at durable/wire boundaries). */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Error text matching the preset's `error && error.message ? error.message : String(error)`. */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** Non-empty string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Positive integer, or undefined. */
function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Validate the row config. Misconfiguration fails loud at mount.
 * @param raw - raw cordis.yml row config (already schema-resolved by the Loader).
 * @returns the resolved bin, stateDir, maxDelegations, and daemonSocket.
 */
export function resolvePrimeConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('prime-orchestrator config must be an object')
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`prime-orchestrator: unknown config key "${key}" (supported: bin, stateDir, maxDelegations, daemonSocket)`)
    }
  }
  const bin = value.bin ?? process.env.PRIME_AGENT_BIN ?? 'prime-agent'
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('prime-orchestrator config.bin must be a non-empty string')
  }
  const stateDir = value.stateDir ?? dshHomePath('prime-orchestrator')
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error('prime-orchestrator config.stateDir must be a non-empty string')
  }
  const maxDelegations = value.maxDelegations ?? 8
  if (typeof maxDelegations !== 'number' || !Number.isInteger(maxDelegations) || maxDelegations <= 0) {
    throw new Error('prime-orchestrator config.maxDelegations must be a positive integer')
  }
  const daemonSocket = value.daemonSocket ?? process.env.PRIME_AGENT_DAEMON_SOCKET ?? null
  if (daemonSocket !== null && (typeof daemonSocket !== 'string' || daemonSocket.length === 0)) {
    throw new Error('prime-orchestrator config.daemonSocket must be a non-empty string')
  }
  return { bin, stateDir, maxDelegations, daemonSocket }
}

/**
 * Absent-binary guidance shared by every spawn failure.
 * @param bin - the configured prime-agent binary.
 * @param error - the spawn error.
 * @returns the user-facing failure message.
 */
export function spawnErrorMessage(bin: string, error: unknown): string {
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
    return `prime-agent binary "${bin}" not found. Install it (curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh), put it on PATH, or set config.bin / PRIME_AGENT_BIN to an absolute path.`
  }
  return `failed to spawn "${bin}": ${messageOf(error)}`
}

/** Fail loud when an optional integer field is present but not a positive int. */
function requirePositiveInt(name: string, value: unknown): void {
  if (value !== undefined && int(value) === undefined) {
    throw new Error(`prime_agent delegate: "${name}" must be a positive integer`)
  }
}

/**
 * Build the argv for a delegated prime-agent JSON-mode session from the
 * validated request, including the optional capability flags. Values are
 * passed positionally (never via a shell), so arbitrary task text cannot
 * break argument parsing.
 * @param task - the self-contained task prompt.
 * @param input - delegation request with optional capability fields.
 * @returns argv (bin is prepended by the caller).
 */
export function buildDelegateArgv(task: string, input: Omit<PrimeDelegateRequest, 'task'>): string[] {
  const argv = ['--mode', 'json']
  const one = str(input.model)
  if (one !== undefined) argv.push('--model', one)
  const provider = str(input.provider)
  if (provider !== undefined) argv.push('--provider', provider)
  const thinking = str(input.thinking)
  if (thinking !== undefined) argv.push('--thinking', thinking)
  if (input.offline === true) argv.push('--offline')
  const goal = str(input.goal)
  if (goal !== undefined) argv.push('--goal', goal)
  const goalBudget = int(input.goalTokenBudget)
  if (goalBudget !== undefined) argv.push('--goal-token-budget', String(goalBudget))
  if (input.continue === true) argv.push('--continue')
  if (typeof input.resume === 'string' && input.resume.length > 0) argv.push('--resume', input.resume)
  for (const ext of Array.isArray(input.extensions) ? input.extensions : []) {
    const e = str(ext)
    if (e !== undefined) argv.push('--extension', e)
  }
  for (const sk of Array.isArray(input.skills) ? input.skills : []) {
    const s = str(sk)
    if (s !== undefined) argv.push('--skill', s)
  }
  for (const asp of Array.isArray(input.appendSystemPrompt) ? input.appendSystemPrompt : []) {
    const a = str(asp)
    if (a !== undefined) argv.push('--append-system-prompt', a)
  }
  if (input.autonomous === true) {
    argv.push('--autonomous')
    for (const g of Array.isArray(input.autonomousGates) ? input.autonomousGates : []) {
      const gate = str(g)
      if (gate !== undefined) argv.push('--autonomous-gate', gate)
    }
    const maxTurns = int(input.autonomousMaxTurns)
    if (maxTurns !== undefined) argv.push('--autonomous-max-turns', String(maxTurns))
    const maxTokens = int(input.autonomousMaxTokens)
    if (maxTokens !== undefined) argv.push('--autonomous-max-tokens', String(maxTokens))
    const timeout = int(input.autonomousTimeoutMs)
    if (timeout !== undefined) argv.push('--autonomous-timeout-ms', String(timeout))
    const gateRetries = int(input.autonomousGateRetries)
    if (gateRetries !== undefined) argv.push('--autonomous-gate-retries', String(gateRetries))
    const gateTimeout = int(input.autonomousGateTimeoutMs)
    if (gateTimeout !== undefined) argv.push('--autonomous-gate-timeout-ms', String(gateTimeout))
    const maxContinuations = int(input.autonomousMaxContinuations)
    if (maxContinuations !== undefined) argv.push('--autonomous-max-continuations', String(maxContinuations))
  }
  const briefing = str(input.briefing)
  const effectiveTask = briefing
    ? '[BRIEFING — verify, do not re-explore]\n' + briefing + '\n\n---\n\n' + task
    : task
  argv.push(effectiveTask)
  return argv
}

/** Fold one stdout chunk into the delegation record's last-event fields. */
/** Turn threshold: N consecutive read-only turns without a mutation trips the warning. */
const EXPLORATION_READ_TURN_LIMIT = 8

/** Mutation indicators for a worker tool call's `args.code` (Python or bash). */
const WRITE_CODE_PATTERNS: RegExp[] = [
  /\.write_text\s*\(/,
  /open\s*\([^)]*['"][wax][b+]?['"]/,
  /\b(?:edit|write|append)\s*\(/,
  /\bsed\s+-i/,
  /\btee\s+/,
  /\bmv\s+\S/,
  /\brm\s+(?:-r?f?\s+)?\S/,
  /\bcp\s+(?:-r\s+)?\S/,
  /\bmkdir\b/,
  /\btouch\s+\S/,
  /\bgit\s+(?:add|commit|checkout|stash|reset|merge|rebase|push|apply)\b/,
  /\bnpm\s+(?:i|install|run\s+build|run\s+pack|publish)\b/,
  /\bpnpm\s+(?:i|install|build|pack)\b/,
  /\byarn\b/,
  /\btsdown\b|\btsc\b|\bgo\s+build\b|\bmake\b/,
  /\b(?:os\.remove|os\.rename|os\.makedirs|shutil\.(?:move|copy|copy2|rmtree))\s*\(/,
  /\bcurl\s+-X\s*(?:POST|PUT|PATCH|DELETE)\b/,
]

/** Classify a worker tool call's code as a mutation ('write') or read-only ('read'). */
export function classifyToolCode(code: string): 'write' | 'read' {
  if (typeof code !== 'string' || code.length === 0) return 'read'
  for (const pattern of WRITE_CODE_PATTERNS) {
    if (pattern.test(code)) return 'write'
  }
  return 'read'
}

function ingestChunk(record: DelegationRecord, chunk: Buffer): void {
  record._lineBuffer = (record._lineBuffer ?? '') + chunk.toString('utf8')
  const lines = record._lineBuffer.split('\n')
  record._lineBuffer = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      // Non-JSON noise on stdout: keep it visible but do not corrupt state.
      continue
    }
    const data = asRecord(event)
    if (typeof data.type !== 'string') continue
    record.lastEventType = data.type
    if (data.type === 'turn_start') record._turnHasWrite = false
    if (data.type === 'tool_execution_start') {
      const code = str(asRecord(data.args).code)
      if (code !== undefined && classifyToolCode(code) === 'write') record._turnHasWrite = true
    }
    if (data.type === 'turn_end') {
      if (record._turnHasWrite) {
        record.writeTurns += 1
        record._consecutiveReadOnly = 0
      } else {
        record.readTurns += 1
        record._consecutiveReadOnly += 1
        if (record._consecutiveReadOnly >= EXPLORATION_READ_TURN_LIMIT) record.explorationWarning = true
      }
    }
    if (data.type === 'agent_end') record.sawAgentEnd = true
    if (data.type === 'session' && typeof data.id === 'string' && data.id.length > 0) {
      record.sessionId = data.id
    }
    const message = messageOfEvent(data)
    if (message !== undefined) {
      const text = contentText(message)
      if (text.length > 0) record.lastText = text.slice(0, 500)
    }
  }
}

/** Map a delegate request to a daemon `create` command (resident lifecycle). */
export function buildDaemonCreateConfig(id: string, input: PrimeDelegateRequest & { cwd: string }): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const put = (key: string, value: unknown): void => { if (value !== undefined && value !== null) config[key] = value }
  put('cwd', input.cwd)
  put('provider', str(input.provider))
  put('model', str(input.model))
  put('thinking', str(input.thinking))
  const systemPrompt = str(input.briefing)
    ?? (Array.isArray(input.appendSystemPrompt) ? input.appendSystemPrompt.filter((x): x is string => typeof x === 'string' && x.length > 0).join('\n') || undefined : undefined)
  put('systemPrompt', systemPrompt)
  put('goal', str(input.goal))
  if (input.autonomous === true) {
    const gates = Array.isArray(input.autonomousGates) ? input.autonomousGates.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
    config.autonomous = {
      enabled: true,
      ...(int(input.autonomousMaxTurns) !== undefined ? { maxTurns: int(input.autonomousMaxTurns) } : {}),
      ...(int(input.autonomousMaxTokens) !== undefined ? { maxTokens: int(input.autonomousMaxTokens) } : {}),
      ...(int(input.autonomousTimeoutMs) !== undefined ? { timeoutMs: int(input.autonomousTimeoutMs) } : {}),
      ...(int(input.autonomousMaxContinuations) !== undefined ? { maxContinuations: int(input.autonomousMaxContinuations) } : {}),
      ...(gates.length > 0 ? {
        gates: {
          commands: gates,
          ...(int(input.autonomousGateRetries) !== undefined ? { maxRetries: int(input.autonomousGateRetries) } : {}),
          ...(int(input.autonomousGateTimeoutMs) !== undefined ? { timeoutMs: int(input.autonomousGateTimeoutMs) } : {}),
        },
      } : {}),
    }
  }
  return { name: `orchestrator-${id}`, lifecycle: 'resident', config }
}

/** Create a resident (daemon-backed) session and deliver the task via prompt. */
async function startDaemonBackedDelegation(service: PrimeOrchestration, record: DelegationRecord, input: PrimeDelegateRequest & { cwd: string }): Promise<void> {
  const config = service.config
  const create = await daemonRequest(config, { type: 'create', ...buildDaemonCreateConfig(record.id, input) }, 30000)
  if (!create.ok || !isRecord(create.data)) {
    record.status = 'failed'
    record.endedAt = new Date().toISOString()
    record.error = `daemon-backed delegation failed: ${create.ok ? 'no session in response' : create.output}`
    return
  }
  const data = create.data as Record<string, unknown>
  const session = asRecord(data.session)
  const sid = str(data.activeSessionId) ?? str(data.id) ?? str(session.activeSessionId) ?? str(session.id)
  if (sid === undefined) {
    record.status = 'failed'
    record.endedAt = new Date().toISOString()
    record.error = 'daemon create returned no active session id'
    return
  }
  record.activeSessionId = sid
  if (record.sessionId === null) record.sessionId = str(data.sessionId) ?? sid
  const prompt = await daemonRequest(config, { type: 'prompt', activeSessionId: sid, message: input.task, queueIfBusy: false }, 30000)
  if (!prompt.ok) {
    record.status = 'failed'
    record.endedAt = new Date().toISOString()
    record.error = `daemon prompt failed: ${prompt.output}`
    return
  }
  const schedule = str(input.heartbeatSchedule)
  if (schedule !== undefined) {
    await daemonRequest(config, {
      type: 'heartbeat_set',
      activeSessionId: sid,
      schedule,
      prompt: str(input.heartbeatMessage) ?? 'Heartbeat checkpoint',
      ...(input.heartbeatDelivery !== undefined ? { deliveryMode: input.heartbeatDelivery } : {}),
    }, 10000)
  }
  await trackDaemonDelegation(service, record, sid, input)
}

/** Poll a daemon-backed delegation until idle, then finalize its record. */
async function trackDaemonDelegation(service: PrimeOrchestration, record: DelegationRecord, sid: string, input: PrimeDelegateRequest & { cwd: string }): Promise<void> {
  const config = service.config
  const deadline = Date.now() + (int(input.autonomousTimeoutMs) ?? 1800000)
  let reachedIdle = false
  while (Date.now() < deadline) {
    const idle = await daemonRequest(config, { type: 'wait_for_idle', activeSessionId: sid }, 60000)
    if (idle.ok) { reachedIdle = true; break }
    if (!/timed out|timeout/i.test(idle.output ?? '')) {
      record.status = 'failed'
      record.endedAt = new Date().toISOString()
      record.error = `daemon wait_for_idle failed: ${idle.output}`
      return
    }
  }
  const last = await daemonRequest(config, { type: 'get_last_assistant_text', activeSessionId: sid }, 15000)
  if (last.ok && isRecord(last.data)) record.lastText = str(last.data.text) ?? null
  if (reachedIdle) {
    record.sawAgentEnd = true
    record.status = 'exited'
    record.endedAt = new Date().toISOString()
  }
}

/** Start one background prime-agent session in JSON mode. */
function startDelegation(service: PrimeOrchestration, input: PrimeDelegateRequest & { cwd: string }): DelegationRecord {
  const config = service.config
  const dir = join(config.stateDir, 'delegations')
  mkdirSync(dir, { recursive: true })
  const id = randomUUID().slice(0, 8)
  const logFile = join(dir, `${id}.jsonl`)
  const stderrFile = join(dir, `${id}.stderr`)
  const record: DelegationRecord = {
    id,
    task: input.task,
    cwd: input.cwd,
    sessionId: null,
    activeSessionId: null,
    pid: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    logFile,
    stderrFile,
    lastEventType: null,
    lastText: null,
    sawAgentEnd: false,
    readTurns: 0,
    writeTurns: 0,
    explorationWarning: false,
    error: null,
    child: null,
    _lineBuffer: '',
    _turnHasWrite: false,
    _consecutiveReadOnly: 0,
  }
  if (input.daemonBacked === true) {
    service.records.set(id, record)
    void startDaemonBackedDelegation(service, record, input)
    return record
  }
  let child: SpawnedChild
  try {
    child = spawn(config.bin, buildDelegateArgv(input.task, input), {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as SpawnedChild
  } catch (error) {
    record.status = 'failed'
    record.endedAt = new Date().toISOString()
    record.error = spawnErrorMessage(config.bin, error)
    service.records.set(id, record)
    throw new PrimeDelegationStartError(delegationView(record), spawnErrorMessage(config.bin, error))
  }
  record.child = child
  record.pid = child.pid ?? null
  const out = createWriteStream(logFile, { flags: 'a' })
  const err = createWriteStream(stderrFile, { flags: 'a' })
  child.stdout.on('data', (chunk) => {
    out.write(chunk)
    ingestChunk(record, chunk)
  })
  child.stderr.on('data', chunk => err.write(chunk))
  child.on('error', (error) => {
    record.status = 'failed'
    record.error = spawnErrorMessage(config.bin, error)
    record.endedAt = new Date().toISOString()
    out.end()
    err.end()
  })
  child.on('close', (code) => {
    if (record.status === 'running') {
      record.status = code === 0 ? 'exited' : 'failed'
      if (code !== 0) record.error = `prime-agent exited with code ${code}; see ${stderrFile}`
    }
    record.exitCode = code
    record.endedAt = new Date().toISOString()
    record.child = null
    out.end()
    err.end()
  })
  service.records.set(id, record)
  return record
}

/** Stop one delegation's child process, if it is still running. */
function stopDelegation(record: DelegationRecord): boolean {
  if (record.status !== 'running' || record.child === null) return false
  record.status = 'stopped'
  record.endedAt = new Date().toISOString()
  record.child.kill('SIGTERM')
  return true
}

/**
 * Run a one-shot prime-agent CLI command and collect its bounded output.
 * @param config - resolved config (bin only).
 * @param argv - CLI arguments.
 * @param cwd - working directory.
 * @param signal - caller cancellation; aborts kill the child.
 * @param timeoutMs - hard timeout; expiry kills the child.
 * @param capLimit - max output characters before head/tail truncation.
 * @returns the bounded command result.
 */
export function runCli(config: { bin: string }, argv: string[], cwd: string, signal: AbortSignal | undefined, timeoutMs: number, capLimit = 6000): Promise<CliResult> {
  return new Promise((resolve) => {
    let child: SpawnedChild
    try {
      child = spawn(config.bin, argv, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }) as SpawnedChild
    } catch (error) {
      resolve({ ok: false, code: null, output: spawnErrorMessage(config.bin, error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const half = Math.floor(capLimit / 2)
    const cap = (text: string): string => (text.length > capLimit ? `${text.slice(0, half)}\n…[truncated]…\n${text.slice(-half)}` : text)
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (result: CliResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      child.kill('SIGTERM')
      finish({ ok: false, code: null, output: 'cancelled by the caller' })
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: null, output: `command timed out after ${timeoutMs}ms\n${cap(stderr)}` })
    }, timeoutMs)
    if (signal !== undefined) {
      if (signal.aborted) {
        child.kill('SIGTERM')
        finish({ ok: false, code: null, output: 'cancelled by the caller' })
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', error => finish({ ok: false, code: null, output: spawnErrorMessage(config.bin, error) }))
    child.on('close', code => finish({
      ok: code === 0,
      code,
      output: cap(code === 0 ? stdout : `${stdout}\n${stderr}`.trim()),
    }))
  })
}

/** Event types that are high-frequency streaming deltas, not milestones. */
const STREAMING_EVENT_TYPES = new Set(['message_update', 'tool_execution_update'])

/**
 * Read the trailing JSON events of one delegation log, bounded, with the
 * per-delta streaming rows filtered out so the window shows milestones.
 * @param record - delegation whose log file is read.
 * @param limit - maximum trailing events to return.
 * @returns the chosen summarized events, oldest first.
 */
export function readEvents(record: { logFile: string }, limit: number): EventSummary[] {
  if (!existsSync(record.logFile)) return []
  const lines = readFileSync(record.logFile, 'utf8').split('\n').filter(line => line.trim().length > 0)
  const parseLine = (line: string): EventSummary => {
    try {
      return summarizeEvent(JSON.parse(line))
    } catch {
      return { type: 'unparsed', text: line.slice(0, 200) }
    }
  }
  const milestones: EventSummary[] = []
  for (let i = lines.length - 1; i >= 0 && milestones.length < limit; i--) {
    const summary = parseLine(lines[i]!)
    if (!STREAMING_EVENT_TYPES.has(summary.type)) milestones.push(summary)
  }
  const chosen = milestones.length > 0 ? milestones : lines.slice(-limit).map(parseLine)
  return chosen.reverse()
}

/**
 * Read the trailing milestone events of an arbitrary prime-agent session
 * `.jsonl` file — the same filtered tail read as {@link readEvents}, but for
 * sessions that were not started by this orchestrator process.
 * @param file - the absolute session `.jsonl` path.
 * @param limit - maximum trailing events to return.
 * @returns the chosen summarized events, oldest first.
 */
export function readSessionFileEvents(file: string, limit: number): EventSummary[] {
  return readEvents({ logFile: file }, limit)
}

/** Extract the assistant text blocks of one message payload. */
function contentText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

/** Pick the message-bearing payload of one event, in either event family. */
function messageOfEvent(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = data.message
  if (isRecord(message) && Array.isArray(message.content)) return message
  const messages = data.messages
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1]
    if (isRecord(last)) return last
  }
  return undefined
}

/**
 * Best-effort text extraction from an arbitrary prime-agent payload node.
 * @param value - any payload node.
 * @returns joined text, or null when nothing text-like is present.
 */
export function extractText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.content)) return record.content.map(extractText).filter(Boolean).join('\n')
    const parts: string[] = []
    for (const key of ['summary', 'objective', 'goal', 'message', 'result']) {
      if (typeof record[key] === 'string') parts.push(record[key])
    }
    return parts.join('\n') || null
  }
  return null
}

/**
 * Project one prime-agent JSON event to a small owned summary.
 * @param event - the parsed JSON event.
 * @returns the projected summary.
 */
export function summarizeEvent(event: unknown): EventSummary {
  const data = asRecord(event)
  const summary: EventSummary = { type: typeof data.type === 'string' ? data.type : 'unknown' }
  const message = messageOfEvent(data)
  if (message !== undefined && typeof message.role === 'string') summary.role = message.role
  if (message !== undefined) {
    const text = contentText(message)
    if (text.length > 0) summary.text = text.slice(0, 300)
    const toolCalls = Array.isArray(message.content)
      ? message.content
        .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'toolCall' && typeof block.name === 'string')
        .map(block => block.name as string)
      : []
    if (toolCalls.length > 0) summary.toolCalls = toolCalls
  }
  const goal = summary.type === 'goal_update' && isRecord(data.goal)
    ? data.goal
    : summary.type === 'custom' && data.customType === 'thread_goal_state' && isRecord(data.data)
      ? data.data
      : undefined
  if (goal !== undefined) {
    summary.goalState = {
      status: typeof goal.status === 'string' ? goal.status : null,
      goalId: typeof goal.goalId === 'string' ? goal.goalId : null,
      active: goal.active === true,
      tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : null,
      timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : null,
    }
    if (typeof goal.objective === 'string' && goal.objective.length > 0) {
      summary.objective = goal.objective.slice(0, 300)
    }
  }
  if (summary.type === 'custom_message') {
    summary.customType = typeof data.customType === 'string' ? data.customType : null
    const content = typeof data.content === 'string' ? data.content : extractText(data.content)
    if (content) summary.text = content.slice(0, 300)
  }
  if (summary.type === 'tool_execution_start' || summary.type === 'tool_execution_end') {
    if (typeof data.toolName === 'string') summary.toolName = data.toolName
    if (typeof data.toolCallId === 'string') summary.toolCallId = data.toolCallId
    if (summary.type === 'tool_execution_end' && isRecord(data.result) && isRecord(data.result.details)) {
      summary.durationMs = typeof data.result.details.durationMs === 'number' ? data.result.details.durationMs : null
      summary.toolStatus = typeof data.result.details.status === 'string' ? data.result.details.status : null
    }
  }
  if (summary.type === 'compaction') {
    const c = extractText(data)
    if (c) summary.compaction = c.slice(0, 200)
  }
  if (summary.type === 'agent_status' && isRecord(data.status)) {
    summary.taskState = typeof data.status.taskState === 'string' ? data.status.taskState : null
    summary.needsInput = data.status.taskState === 'needs_input'
  }
  return summary
}

/**
 * Public view of one delegation record (no live handles).
 * @param record - internal delegation record.
 * @returns the client-safe view.
 */
export function delegationView(record: DelegationRecord): PrimeDelegation {
  return {
    id: record.id,
    task: record.task.length > 200 ? `${record.task.slice(0, 200)}…` : record.task,
    cwd: record.cwd,
    sessionId: record.sessionId,
    activeSessionId: record.activeSessionId ?? null,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    lastEventType: record.lastEventType,
    lastText: record.lastText,
    completed: record.sawAgentEnd,
    readTurns: record.readTurns,
    writeTurns: record.writeTurns,
    explorationWarning: record.explorationWarning,
    error: record.error,
    logFile: record.logFile,
  }
}

/**
 * Project one daemon session summary to the client-safe agent view.
 * @param summary - the daemon's serialized session row.
 * @returns the projected view.
 */
export function agentView(summary: unknown): AgentView {
  const data = asRecord(summary)
  const model = isRecord(data.model) ? data.model : null
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  return {
    id: text(data.id),
    sessionId: text(data.sessionId),
    sessionFile: text(data.sessionFile),
    sessionName: text(data.sessionName),
    cwd: text(data.cwd),
    firstMessage: text(data.firstMessage),
    model: model !== null && typeof model.name === 'string' && model.name.length > 0 ? model.name : null,
    modelId: model !== null && typeof model.id === 'string' && model.id.length > 0 ? model.id : null,
    thinking: text(data.thinkingLevel),
    lifecycle: text(data.lifecycle),
    activity: text(data.activity),
    daemonBacked: typeof data.workerPid === 'number',
    isSessionActive: data.isSessionActive === true,
    isStreaming: data.isStreaming === true,
    isCompacting: data.isCompacting === true,
    isBashRunning: data.isBashRunning === true,
    isRunningTools: data.isRunningTools === true,
    hasRunningRlmChildren: data.hasRunningRlmChildren === true,
    messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
    unfinishedActionCount: typeof data.unfinishedActionCount === 'number' ? data.unfinishedActionCount : 0,
    attachedClients: typeof data.attachedClients === 'number' ? data.attachedClients : 0,
    taskState: text(data.taskState),
    workerState: text(data.workerState),
    rlmDepth: typeof data.rlmDepth === 'number' ? data.rlmDepth : 0,
    parentSessionId: text(data.parentSessionId),
    hasRegisteredCronJob: data.hasRegisteredCronJob === true,
    hasActiveHeartbeat: data.hasActiveHeartbeat === true,
    nextRunAt: text(data.nextRunAt),
    created: text(data.created),
    modified: text(data.modified),
    lastActivityAt: text(data.lastActivityAt),
  }
}

/**
 * Project one daemon saved-session record to the client-safe view.
 * @param session - the daemon's serialized saved-session info.
 * @returns the projected view.
 */
export function savedSessionView(session: unknown): SavedSessionView {
  const data = asRecord(session)
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  const firstMessage = text(data.firstMessage)
  return {
    id: text(data.id),
    path: text(data.path),
    cwd: text(data.cwd),
    name: text(data.name),
    state: isRecord(data.state) && typeof data.state.status === 'string' ? data.state.status : text(data.state),
    parentSessionPath: text(data.parentSessionPath),
    rlmDepth: typeof data.rlmDepth === 'number' ? data.rlmDepth : 0,
    created: text(data.created),
    modified: text(data.modified),
    messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
    firstMessage: firstMessage !== null ? firstMessage.slice(0, 300) : null,
  }
}

/**
 * Project one cron/heartbeat job to the client-safe heartbeat view.
 * @param job - the daemon's job record.
 * @param extra - catalog decoration carrying session display facts.
 * @returns the projected view.
 */
export function heartbeatView(job: unknown, extra: unknown): HeartbeatView {
  const data = asRecord(job)
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  const schedule = isRecord(data.schedule) ? data.schedule : null
  const extraData = isRecord(extra) ? extra : null
  const prompt = text(data.prompt)
  return {
    id: text(data.id),
    status: text(data.status),
    source: text(data.source),
    runtimeKind: text(data.runtimeKind),
    deliveryMode: text(data.deliveryMode),
    activeSessionId: text(data.activeSessionId),
    sessionId: text(data.sessionId) ?? (extraData !== null ? text(extraData.sessionId) : null),
    scheduleKind: schedule !== null ? text(schedule.kind) : null,
    schedule: schedule !== null ? text(schedule.expression) : null,
    intervalMs: schedule !== null && typeof schedule.intervalMs === 'number' ? schedule.intervalMs : null,
    label: text(data.label),
    prompt: prompt !== null ? prompt.slice(0, 300) : null,
    nextRunAt: text(data.nextRunAt),
    lastRunAt: text(data.lastRunAt),
    lastSkippedAt: text(data.lastSkippedAt),
    lastError: text(data.lastError),
    runCount: typeof data.runCount === 'number' ? data.runCount : 0,
    createdAt: text(data.createdAt),
    updatedAt: text(data.updatedAt),
    sessionName: extraData !== null ? text(extraData.sessionName) : null,
    firstMessage: extraData !== null ? text(extraData.firstMessage) : null,
  }
}

/**
 * List prime-agent's own persisted sessions with recency metadata.
 * @returns the sessions directory and newest-first listing.
 */
export function listPrimeSessions(): PrimeSessionsListing {
  const dir = primeSessionsDir()
  if (!existsSync(dir)) return { dir, sessions: [] }
  const sessions = readdirSync(dir)
    .filter(file => file.endsWith('.jsonl'))
    .map((file) => {
      const path = join(dir, file)
      const info = statSync(path)
      return {
        id: file.replace(/\.jsonl$/, ''),
        file: path,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      }
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  return { dir, sessions }
}

/**
 * prime-agent's daemon session JSONL directory.
 * @returns the absolute directory path.
 */
export function primeSessionsDir(): string {
  return join(homedir(), '.prime', 'agent', 'sessions')
}

/**
 * Default daemon socket path: $TMPDIR/prime-agent-<uid>/daemon.sock.
 * @returns the absolute socket path.
 */
export function defaultDaemonSocket(): string {
  /* v8 ignore next -- non-POSIX fallback: macOS/Linux CI always provides process.getuid */
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  return join(tmpdir(), `prime-agent-${uid}`, 'daemon.sock')
}

/**
 * Send one command over the daemon socket and resolve its response data.
 * @param config - resolved config carrying the optional daemonSocket override.
 * @param command - the protocol command body (without the id).
 * @param timeoutMs - hard timeout; expiry rejects.
 * @returns the success payload under `data`, or the error text under `output`.
 */
/**
 * Deliver one prompt to a running daemon session through the daemon `prompt`
 * command, with the queue/steer/follow-up delivery the orchestration loop needs.
 * Session slash commands (`/goal`, `/autonomous`, `/refine`, ...) are parsed by
 * the session, so they work through this route. A session left with suspended
 * input admission (for example after an aborted update restart) gets one
 * `resume_queue` attempt before the prompt is retried.
 * @param config - the resolved plugin config (binary + socket override).
 * @param agent - the target's daemon active session id.
 * @param message - the prompt text, or a session slash command like `/goal pause`.
 * @param delivery - how to deliver while the session is busy: `steer` interrupts
 * the current turn, `follow_up` queues after it, and the default queues without
 * steering (starts immediately when the session is idle).
 * @returns the daemon's admission receipt.
 */
export async function promptDaemonSession(config: PrimeConfig, agent: string, message: string, delivery?: 'steer' | 'follow_up'): Promise<{ delivered: boolean; receipt: unknown; disposition?: string }> {
  const command: Record<string, unknown> = {
    type: 'prompt',
    activeSessionId: agent,
    message,
    ...(delivery === 'steer' ? { streamingBehavior: 'steer' } : {}),
    ...(delivery === 'follow_up' ? { streamingBehavior: 'followUp' } : {}),
    ...(delivery === undefined ? { queueIfBusy: true } : {}),
  }
  let result = await daemonRequest(config, command, 60000)
  if (!result.ok && /suspended/i.test(result.output)) {
    const resumed = await daemonRequest(config, { type: 'resume_queue', activeSessionId: agent }, 15000)
    if (!resumed.ok) throw new Error(`prime_agent prompt: ${result.output} (resume_queue also failed: ${resumed.output})`)
    result = await daemonRequest(config, command, 60000)
  }
  if (!result.ok) throw new Error(`prime_agent prompt: ${result.output}`)
  const data = isRecord(result.data) ? result.data : {}
  return { delivered: true, receipt: result.data, disposition: typeof data.status === 'string' ? data.status : undefined }
}

/** Project one `get_available_models` entry into a stable, model-friendly row. */
export function modelView(model: unknown): Record<string, unknown> {
  const m = asRecord(model)
  return {
    provider: typeof m.provider === 'string' ? m.provider : undefined,
    id: typeof m.id === 'string' ? m.id : undefined,
    name: typeof m.name === 'string' ? m.name : undefined,
    reasoning: m.reasoning === true,
    input: Array.isArray(m.input) ? m.input.filter((v): v is string => typeof v === 'string') : undefined,
    contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
    maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : undefined,
    ...(isRecord(m.cost) ? { cost: m.cost } : {}),
  }
}

/** Extract display text from a content string or block list, bounded to `limit` chars. */
function messageText(content: unknown, limit: number): string | undefined {
  if (typeof content === 'string') return content.slice(0, limit)
  if (!Array.isArray(content)) return undefined
  let out = ''
  for (const block of content) {
    if (out.length >= limit) break
    const b = asRecord(block)
    const text = typeof b.text === 'string' ? b.text : undefined
    if (text === undefined) continue
    out = out.length === 0 ? text.slice(0, limit) : `${out}\n${text}`.slice(0, limit)
  }
  return out.length > 0 ? out : undefined
}

/** Project one conversation message into a bounded, model-friendly row. */
export function messageView(message: unknown, limit = 500): Record<string, unknown> {
  const m = asRecord(message)
  return {
    role: typeof m.role === 'string' ? m.role : undefined,
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
    ...(typeof m.toolName === 'string' ? { tool: m.toolName } : {}),
    text: messageText(m.content, limit),
  }
}

/** Project one `get_rlm_children` snapshot into a stable, model-friendly row. */
export function rlmChildView(child: unknown): Record<string, unknown> {
  const c = asRecord(child)
  return {
    id: typeof c.id === 'string' ? c.id : undefined,
    sessionName: typeof c.sessionName === 'string' ? c.sessionName : undefined,
    label: typeof c.label === 'string' ? c.label : undefined,
    status: typeof c.status === 'string' ? c.status : undefined,
    model: typeof c.model === 'string' ? c.model : undefined,
    tokens: typeof c.tokenCount === 'number' ? c.tokenCount : undefined,
    toolUses: typeof c.toolUseCount === 'number' ? c.toolUseCount : undefined,
    durationMs: typeof c.durationMs === 'number' ? c.durationMs : undefined,
    replied: c.repliedSinceTask === true,
    answerPreview: typeof c.answerPreview === 'string' ? c.answerPreview.slice(0, 400) : undefined,
    sessionDir: typeof c.sessionDir === 'string' ? c.sessionDir : undefined,
    ...(typeof c.error === 'string' && c.error.length > 0 ? { error: c.error } : {}),
  }
}

export function daemonRequest(config: PrimeConfig, command: Record<string, unknown>, timeoutMs: number): Promise<DaemonResult> {
  return new Promise((resolve) => {
    const socketPath = config.daemonSocket ?? defaultDaemonSocket()
    let socket: ReturnType<typeof createConnection>
    try {
      socket = createConnection(socketPath)
    } catch (error) {
      resolve({ ok: false, output: `cannot open the prime-agent daemon socket: ${messageOf(error)}` })
      return
    }
    let buffer = ''
    let settled = false
    let timer: NodeJS.Timeout
    const id = `dsh_${randomUUID()}`
    const fail = (output: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ ok: false, output })
    }
    const finish = (data: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      resolve({ ok: true, data })
    }
    timer = setTimeout(() => fail(`daemon command "${command.type}" timed out after ${timeoutMs}ms`), timeoutMs)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        type: 'command',
        id,
        protocol: { name: 'prime-agent.daemon', version: 7 },
        command,
      })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let lineEnd
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 1)
        if (line.trim().length === 0) continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (isRecord(message) && message.type === 'response' && message.id === id) {
          if (message.success === true) finish(message.data)
          else fail(typeof message.error === 'string' && message.error.length > 0 ? message.error : `daemon rejected "${command.type}"`)
          return
        }
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        fail('prime-agent daemon is not running; start a daemon-backed session or run prime-agent doctor')
      } else if (error.code === 'ECONNREFUSED') {
        fail(`prime-agent daemon refused the connection at ${socketPath}; run prime-agent doctor`)
      } else {
        fail(`daemon socket error: ${messageOf(error)}`)
      }
    })
  })
}

/**
 * List the daemon's heartbeat and scheduled-prompt jobs, projected.
 * @param config - resolved config.
 * @returns the projected jobs, or the daemon failure.
 */
export async function listHeartbeats(config: PrimeConfig): Promise<HeartbeatsResult> {
  const jobsResult = await daemonRequest(config, { type: 'cron_list', includeInactive: true }, 10000)
  if (!jobsResult.ok) return jobsResult
  const jobsData = jobsResult.data
  const jobs = isRecord(jobsData) && Array.isArray(jobsData.jobs) ? jobsData.jobs : []
  const catalog = await daemonRequest(config, { type: 'heartbeats_list' }, 10000)
  const byJobId = new Map<string, unknown>()
  if (catalog.ok && isRecord(catalog.data) && Array.isArray(catalog.data.heartbeats)) {
    for (const entry of catalog.data.heartbeats) {
      const job = isRecord(entry) ? entry.job : undefined
      if (isRecord(job) && typeof job.id === 'string') byJobId.set(job.id, entry)
    }
  }
  return {
    ok: true,
    jobs: jobs
      .filter((job): job is Record<string, unknown> => isRecord(job) && (job.status === 'active' || job.status === 'paused'))
      .map(job => heartbeatView(job, typeof job.id === 'string' ? byJobId.get(job.id) : undefined)),
  }
}

/**
 * Fetch and project the daemon's agent roster.
 * @param config - resolved config.
 * @param cwd - working directory.
 * @param all - include saved (draft) agents.
 * @param signal - caller cancellation.
 * @returns the projected agents, or the CLI failure.
 */
export async function listAgents(config: PrimeConfig, cwd: string, all: boolean, signal: AbortSignal | undefined): Promise<ListAgentsResult> {
  const argv = all ? ['list', '--all', '--json'] : ['list', '--json']
  const result = await runCli(config, argv, cwd, signal, 30000, 5_000_000)
  if (!result.ok) return { ok: false, output: result.output }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.output)
  } catch {
    return { ok: false, output: 'prime-agent list --json returned non-JSON output' }
  }
  const sessions = isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : []
  return { ok: true, agents: sessions.map(agentView) }
}

/**
 * Resolve an agent name, short agent id, or session id to the daemon active
 * session id that send_message, heartbeat_get, and agent_messages need.
 * @param config - resolved config.
 * @param target - name or id to resolve.
 * @param cwd - working directory.
 * @param signal - caller cancellation.
 * @returns the active session id, or the raw target as a fallback.
 */
export async function resolveAgentActiveId(config: PrimeConfig, target: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  const roster = await listAgents(config, cwd, false, signal)
  if (!roster.ok || !('agents' in roster)) return target
  const match = roster.agents.find(agent =>
    agent.id === target || agent.sessionId === target || agent.sessionName === target)
  return match !== undefined && typeof match.id === 'string' && match.id.length > 0 ? match.id : target
}

/** Options for {@link resolveSessionIdentity}. */
export interface ResolveIdentityOptions {
  /**
   * Roster provider override. Defaults to the `prime-agent list --json` CLI
   * roster; tests inject an in-memory roster.
   */
  fetchRoster?: (cwd: string, signal: AbortSignal | undefined) => Promise<ListAgentsResult>
  /**
   * Sessions directory override. Defaults to `~/.prime/agent/sessions`;
   * tests point this at a temp directory.
   */
  sessionsDir?: string
  /**
   * Return an identity with every handle null instead of throwing when
   * nothing matches. An ambiguous session-id prefix still throws.
   */
  allowUnresolved?: boolean
}

/**
 * Resolve any prime-agent id form into every applicable handle.
 *
 * Three namespaces are searched and merged: the in-process delegation table
 * (8-char delegation ids), the daemon agent roster (active session ids, full
 * session ids, session names), and the session-file directory (full session
 * ids or unique prefixes). The first candidate tried as a file is a known full
 * session id, so an 8-char delegation id is never mistaken for a file prefix.
 *
 * @param records - the in-process delegation table (delegation id → record).
 * @param config - resolved config, used only by the default roster fetch.
 * @param id - the id to resolve: delegation id, active session id, full
 * session id (or unique prefix), or session name.
 * @param cwd - working directory for the roster CLI fetch.
 * @param signal - caller cancellation for the roster fetch.
 * @param options - roster/sessions-dir overrides and unresolved behavior.
 * @returns the merged identity across every namespace that matched.
 * @throws on an empty id, an ambiguous session-id prefix, or (unless
 * `allowUnresolved`) an id that matches nothing.
 */
export async function resolveSessionIdentity(
  records: ReadonlyMap<string, { sessionId: string | null }>,
  config: PrimeConfig,
  id: string,
  cwd: string,
  signal?: AbortSignal,
  options: ResolveIdentityOptions = {},
): Promise<ResolvedIdentity> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('prime_agent: a non-empty id is required')
  }
  const sessionsDir = options.sessionsDir ?? primeSessionsDir()
  const fetchRoster = options.fetchRoster
    ?? ((rosterCwd: string, rosterSignal: AbortSignal | undefined) => listAgents(config, rosterCwd, false, rosterSignal))
  const identity: ResolvedIdentity = {
    delegationId: null,
    activeSessionId: null,
    sessionId: null,
    sessionFile: null,
    sessionName: null,
    source: 'session-file',
  }
  // 1. In-process delegation records: an exact delegation id, or a full
  //    session id owned by one of them.
  let delegationId: string | null = null
  let record = records.get(id)
  if (record === undefined) {
    for (const [key, candidate] of records) {
      if (candidate.sessionId === id) {
        delegationId = key
        record = candidate
        break
      }
    }
  } else {
    delegationId = id
  }
  if (record !== undefined && delegationId !== null) {
    identity.delegationId = delegationId
    if (record.sessionId !== null) identity.sessionId = record.sessionId
  }
  // 2. Daemon roster: match the raw id (or a delegation's session id) against
  //    the active session id / session id, then against the session name.
  let roster: ListAgentsResult | null = null
  try {
    roster = await fetchRoster(cwd, signal)
  } catch {
    roster = null
  }
  let rosterAgent: AgentView | null = null
  let matchedByName = false
  if (roster !== null && roster.ok && 'agents' in roster) {
    const needles = new Set([id, identity.sessionId].filter((value): value is string => typeof value === 'string' && value.length > 0))
    for (const agent of roster.agents) {
      if ((agent.id !== null && needles.has(agent.id)) || (agent.sessionId !== null && needles.has(agent.sessionId))) {
        rosterAgent = agent
        break
      }
    }
    if (rosterAgent === null) {
      for (const agent of roster.agents) {
        if (agent.sessionName !== null && agent.sessionName === id) {
          rosterAgent = agent
          matchedByName = true
          break
        }
      }
    }
  }
  if (rosterAgent !== null) {
    if (rosterAgent.id !== null) identity.activeSessionId = rosterAgent.id
    if (rosterAgent.sessionId !== null && identity.sessionId === null) identity.sessionId = rosterAgent.sessionId
    if (rosterAgent.sessionName !== null) identity.sessionName = rosterAgent.sessionName
    if (rosterAgent.sessionFile !== null) identity.sessionFile = rosterAgent.sessionFile
  }
  // 3. Session files: a known full session id first (exact), then the raw id
  //    (exact or unique prefix). An ambiguous raw-id prefix is remembered.
  let ambiguous: string | null = null
  const fileCandidates = [identity.sessionId, id].filter((value, index, all): value is string =>
    typeof value === 'string' && value.length > 0 && all.indexOf(value) === index)
  for (const candidate of fileCandidates) {
    try {
      const file = resolveSessionFileIn(sessionsDir, candidate)
      identity.sessionFile = file
      identity.sessionId = basename(file, '.jsonl')
      break
    } catch (error) {
      const message = messageOf(error)
      if (candidate === id && /ambiguous/.test(message)) ambiguous = message
    }
  }
  if (identity.sessionId === null && rosterAgent !== null && rosterAgent.sessionFile !== null) {
    // A running session whose file the daemon knows but has not written yet.
    identity.sessionId = basename(rosterAgent.sessionFile, '.jsonl')
  }
  const matched = identity.delegationId !== null || identity.activeSessionId !== null
    || identity.sessionId !== null || identity.sessionFile !== null
  if (matched) {
    identity.source = record !== undefined ? 'delegation'
      : rosterAgent !== null ? (matchedByName ? 'name' : 'agent')
        : 'session-file'
    return identity
  }
  if (ambiguous !== null) throw new Error(ambiguous)
  if (options.allowUnresolved === true) return identity
  const rosterNote = roster === null
    ? 'daemon roster unreachable'
    : roster.ok
      ? `daemon roster (${roster.agents.length} agents)`
      : `daemon roster unreachable (${roster.output})`
  throw new Error(
    `unknown prime-agent id "${id}" — tried: in-process delegation records (${records.size}), ${rosterNote}, and session files in ${sessionsDir}`,
  )
}

/**
 * Build the catalog decoration that fills a heartbeat view's `sessionId` and
 * `sessionName` from a resolved identity.
 * @param identity - the resolved identity, or null when unresolvable.
 * @returns the `extra` object for {@link heartbeatView}.
 */
export function heartbeatExtra(identity: ResolvedIdentity | null): Record<string, unknown> {
  if (identity === null) return {}
  return {
    ...(identity.sessionId !== null ? { sessionId: identity.sessionId } : {}),
    ...(identity.sessionName !== null ? { sessionName: identity.sessionName } : {}),
  }
}

/**
 * Resolve a prime-agent session JSONL file by exact filename or short-prefix id.
 * @param id - exact session id or short prefix.
 * @returns the resolved file path.
 */
export function resolveSessionFile(id: unknown): string {
  return resolveSessionFileIn(primeSessionsDir(), id)
}

/**
 * Resolve a prime-agent session JSONL file inside one directory by exact
 * filename or short-prefix id.
 * @param dir - the sessions directory to search.
 * @param id - exact session id or short prefix.
 * @returns the resolved file path.
 */
export function resolveSessionFileIn(dir: string, id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('prime_agent: a non-empty session id is required')
  }
  if (!existsSync(dir)) throw new Error(`no prime-agent sessions directory at ${dir}`)
  const exact = join(dir, `${id}.jsonl`)
  if (existsSync(exact)) return exact
  const matches = readdirSync(dir).filter(file => file.endsWith('.jsonl') && file.startsWith(id))
  if (matches.length === 1) return join(dir, matches[0]!)
  if (matches.length > 1) {
    throw new Error(`ambiguous session id "${id}" (${matches.length} prefixes match); pass a longer id`)
  }
  throw new Error(`unknown prime-agent session id "${id}"`)
}

/**
 * Read a prime-agent daemon session file and surface its goal lifecycle,
 * compaction, and idle state plus a trailing window of summarized events.
 * @param id - exact session id or short prefix.
 * @param eventLimit - max trailing events to return (0 = none).
 * @returns the session inspection.
 */
export function inspectSession(id: string, eventLimit: number): SessionInspection {
  const file = resolveSessionFile(id)
  const info = statSync(file)
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
  let goalState: EventSummary['goalState'] | null = null
  let goalContext: string | null = null
  let lastSlashResult: string | null = null
  let lastCompaction: string | null = null
  let lastActivityType: string | null = null
  let trailingIdleCount = 0
  const all: EventSummary[] = []
  for (const line of lines) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const summary = summarizeEvent(event)
    lastActivityType = summary.type
    if (summary.needsInput === true) trailingIdleCount++
    else trailingIdleCount = 0
    if (summary.goalState) goalState = summary.goalState
    if (summary.customType === 'goal_context' && summary.text) goalContext = summary.text
    if (summary.customType === 'session_slash_command_result' && summary.text) lastSlashResult = summary.text
    if (summary.type === 'compaction' && summary.compaction) lastCompaction = summary.compaction
    all.push(summary)
  }
  const limit = Math.max(eventLimit > 0 ? eventLimit : 0, 0)
  const events = limit > 0 ? all.slice(-Math.min(limit, 200)) : []
  return {
    id,
    file,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    goal: goalState,
    goalContext: goalContext !== null ? goalContext.slice(0, 800) : null,
    lastSlashCommandResult: lastSlashResult !== null ? lastSlashResult.slice(0, 500) : null,
    lastCompaction,
    idle: trailingIdleCount >= 3,
    lastActivityType,
    events,
  }
}

/** Schema defaults for the settings namespace, mirroring the client form. */
const PrimeSettingsSchema: z<PrimeSettings> = z.object({
  enabled: z.boolean().default(true),
  maxDelegations: z.number().step(1).min(1).default(8),
  bin: z.string().default(''),
  stateDir: z.string().default(''),
  daemonSocket: z.string().default(''),
  heartbeatIntervalMs: z.number().default(0),
  heartbeatTimeoutMs: z.number().default(0),
  delegateModel: z.string().default(''),
  delegateProvider: z.string().default(''),
  delegateThinking: z.string().default(''),
  delegateGoalTokenBudget: z.number().default(0),
  delegateAutonomous: z.boolean().default(false),
  delegateAutonomousMaxContinuations: z.number().default(0),
})

/** Sync spawn failure carrying the failed delegation view for the web handler. */
class PrimeDelegationStartError extends Error {
  readonly delegation: PrimeDelegation

  constructor(delegation: PrimeDelegation, message: string) {
    super(message)
    this.name = 'PrimeDelegationStartError'
    this.delegation = delegation
  }
}

/** Freeze a value and every nested object/array it reaches. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** Read a bounded JSON request body. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk.toString('utf8')
      if (text.length > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(text.length > 0 ? text : '{}'))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * Host-plane Prime Orchestration service.
 *
 * Owns the shared delegation table, the exit hook, the `prime` settings
 * namespace, and the `/prime` web prefix. Settings and web-server absence are
 * both supported: the service keeps working on the row config and schema
 * defaults alone.
 */
export class PrimeOrchestration extends Service {
  /** Runtime schema for the row config (Loader validation and defaults). */
  static Config = z.object({
    bin: z.string().min(1).default(process.env.PRIME_AGENT_BIN ?? 'prime-agent'),
    stateDir: z.string().min(1).default(dshHomePath('prime-orchestrator')),
    daemonSocket: z.union([z.string().min(1), z.const(null)]).default(process.env.PRIME_AGENT_DAEMON_SOCKET ?? null),
    maxDelegations: z.number().step(1).min(1).default(8),
  }) as z<Config>

  /** Shared delegation table, read by the module-level lifecycle helpers. */
  readonly records = new Map<string, DelegationRecord>()
  private readonly generations: PrimeGeneration[] = []
  private generation: PrimeGeneration
  private readonly exitHandler: () => void
  private resolvedConfig: PrimeConfig
  private readonly rowConfig: Config
  /** Short-lived daemon roster cache: `prime-agent list --json` is a subprocess. */
  private rosterCache: { at: number; promise: Promise<ListAgentsResult> } | null = null

  constructor(ctx: Context, rowConfig: Config) {
    super(ctx, 'prime')
    const entry = resolvePrimeConfig(rowConfig)
    this.rowConfig = entry
    this.generation = { id: randomUUID().slice(0, 8), mountedAt: new Date().toISOString(), steps: [] }
    this.generations.push(this.generation)
    mkdirSync(join(entry.stateDir, 'delegations'), { recursive: true })
    mkdirSync(join(entry.stateDir, 'exports'), { recursive: true })

    this.exitHandler = () => {
      for (const record of this.records.values()) {
        if (record.status === 'running' && record.child !== null) {
          try {
            record.child.kill('SIGKILL')
          } catch {
            // Process is already gone; teardown must not throw.
          }
        }
      }
    }
    process.once('exit', this.exitHandler)
    ctx.effect(() => () => {
      process.removeListener('exit', this.exitHandler)
    }, 'prime.exitHook()')

    const fallbackSettings: PrimeSettings = {
      enabled: true,
      maxDelegations: entry.maxDelegations,
      bin: entry.bin,
      stateDir: entry.stateDir,
      daemonSocket: entry.daemonSocket ?? '',
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      delegateModel: '',
      delegateProvider: '',
      delegateThinking: '',
      delegateGoalTokenBudget: 0,
      delegateAutonomous: false,
      delegateAutonomousMaxContinuations: 0,
    }
    this.resolvedConfig = deepFreeze(this.toConfig(fallbackSettings))

    ctx.inject(['settings'], (settingsCtx) => {
      this.step('settings.register(prime)', () => {
        const scope = settingsCtx.settings.register(
          settingsNamespace(SETTINGS_NAMESPACE),
          PrimeSettingsSchema,
          { base: { enabled: true, maxDelegations: entry.maxDelegations, bin: entry.bin, stateDir: entry.stateDir, daemonSocket: entry.daemonSocket ?? '', heartbeatIntervalMs: 0, heartbeatTimeoutMs: 0, delegateModel: '', delegateProvider: '', delegateThinking: '', delegateGoalTokenBudget: 0, delegateAutonomous: false, delegateAutonomousMaxContinuations: 0 } },
        )
        this.resolvedConfig = this.toConfig(scope.get())
        const unwatch = scope.watch((next) => {
          this.resolvedConfig = this.toConfig(next)
        })
        settingsCtx.effect(() => () => {
          unwatch()
          this.resolvedConfig = deepFreeze(this.toConfig(fallbackSettings))
        }, 'prime.settings()')
        return () => {}
      })
    })

    // Order-independent: the row may mount before the web server is provided,
    // so the /prime prefix registers through the inject barrier instead of a
    // construction-time sample; a composition without a web server simply
    // never fires it.
    ctx.inject(['webServer'], (webCtx: Context) => {
      const webServer = webCtx.get('webServer')
      if (webServer === undefined) return () => {}
      webCtx.effect(() => this.step('webServer.register(/prime)', () => {
        try {
          return webServer.register({
            kind: 'prefix',
            path: '/prime',
            handler: (req, res) => {
              void this.handleWeb(req, res)
            },
          })
        } catch {
          // A previous mount generation of this service already serves /prime;
          // its handler reads the same shared state, so duplicate registration
          // is a no-op rather than an error.
          return () => {}
        }
      }), 'webServer.register(/prime)')
      return () => {}
    })
  }

  /** Live-resolved config (schema defaults, row config, then the user layer). */
  get config(): PrimeConfig {
    return this.resolvedConfig
  }

  /** Every delegation started in this process, newest first. */
  delegations(): PrimeDelegation[] {
    return [...this.records.values()].reverse().map(delegationView)
  }

  /**
   * Fetch the daemon agent roster, reusing a fresh cached fetch so repeated
   * id resolution does not respawn `prime-agent list --json`.
   * @param cwd - working directory for the CLI fetch.
   * @param signal - caller cancellation.
   * @param force - bypass the cache and fetch a fresh roster.
   * @returns the projected agents, or the CLI failure.
   */
  private fetchRoster(cwd: string, signal: AbortSignal | undefined, force = false): Promise<ListAgentsResult> {
    if (!force && this.rosterCache !== null && Date.now() - this.rosterCache.at < 5000) {
      return this.rosterCache.promise
    }
    const entry = { at: Date.now(), promise: listAgents(this.config, cwd, false, signal) }
    this.rosterCache = entry
    return entry.promise
  }

  /**
   * Resolve any id form — delegation id, daemon active session id, full
   * session id (or unique prefix), or session name — into every applicable
   * handle.
   * @param id - the id to resolve.
   * @param cwd - working directory for the roster fetch.
   * @param signal - caller cancellation.
   * @param options - overrides and unresolved behavior (see
   * {@link ResolveIdentityOptions}).
   * @returns the merged identity.
   */
  async resolveIdentity(id: string, cwd: string, signal?: AbortSignal, options: ResolveIdentityOptions = {}): Promise<ResolvedIdentity> {
    return resolveSessionIdentity(this.records, this.config, id, cwd, signal, {
      ...options,
      fetchRoster: options.fetchRoster ?? ((rosterCwd: string, rosterSignal: AbortSignal | undefined) => this.fetchRoster(rosterCwd, rosterSignal)),
    })
  }

  /**
   * Resolve one action's `agent` argument to the daemon active session id.
   * A raw value that already is an active session id resolves through the
   * cached roster without a new fetch; a miss retries once against a fresh
   * roster (the cache may predate the session). Falls back to the raw value
   * when nothing resolves, so the daemon reports the failure itself.
   * @param agent - any resolvable id (active session id, session id,
   * delegation id, or session name).
   * @param cwd - working directory for the roster fetch.
   * @param signal - caller cancellation.
   * @returns the daemon active session id, or the raw value.
   */
  private async resolveAgentArg(agent: string, cwd: string, signal?: AbortSignal): Promise<string> {
    try {
      let identity = await this.resolveIdentity(agent, cwd, signal, { allowUnresolved: true })
      if (identity.activeSessionId === null) {
        identity = await this.resolveIdentity(agent, cwd, signal, {
          allowUnresolved: true,
          fetchRoster: (rosterCwd: string, rosterSignal: AbortSignal | undefined) => this.fetchRoster(rosterCwd, rosterSignal, true),
        })
      }
      return identity.activeSessionId ?? agent
    } catch {
      return agent
    }
  }

  /**
   * Best-effort identity lookup for decorating responses (heartbeat views):
   * null when the id does not resolve.
   */
  private async agentIdentity(agent: string, cwd: string, signal?: AbortSignal): Promise<ResolvedIdentity | null> {
    try {
      return await this.resolveIdentity(agent, cwd, signal, { allowUnresolved: true })
    } catch {
      return null
    }
  }

  /**
   * Inspect the session file behind one resolved identity: the full session id
   * when known, else the active session id. A roster-matched session whose
   * file has not been written yet yields a pending view instead of an error.
   * @param identity - the resolved identity.
   * @param fallbackId - the raw id, used when nothing better is known.
   * @param eventLimit - max trailing events to return (0 = none).
   * @returns the session inspection.
   */
  private inspectIdentitySession(identity: ResolvedIdentity, fallbackId: string, eventLimit: number): SessionInspection {
    const hasFile = identity.sessionFile !== null && existsSync(identity.sessionFile)
    if (identity.activeSessionId !== null && !hasFile) {
      // The daemon roster matched but the session file does not exist yet.
      const sessionId = identity.sessionId ?? fallbackId
      return {
        id: sessionId,
        file: identity.sessionFile ?? join(primeSessionsDir(), `${sessionId}.jsonl`),
        sizeBytes: 0,
        modifiedAt: new Date().toISOString(),
        goal: null,
        goalContext: null,
        lastSlashCommandResult: null,
        lastCompaction: null,
        idle: false,
        lastActivityType: null,
        events: [],
      }
    }
    return inspectSession(identity.sessionId ?? identity.activeSessionId ?? fallbackId, eventLimit)
  }

  /**
   * Resolve the trailing events of one delegation or session by any id form:
   * an in-process delegation record first, then a session file on disk.
   * @param id - delegation id, session id, active session id, or name.
   * @param cwd - working directory for the roster fetch.
   * @param limit - maximum trailing events to return.
   * @param signal - caller cancellation.
   * @returns the delegation view with events, or the session file with events.
   */
  private async resolveEvents(id: string, cwd: string, limit: number, signal?: AbortSignal): Promise<{ delegation: PrimeDelegation; events: EventSummary[] } | { sessionId: string; file: string; events: EventSummary[] }> {
    let record = this.records.get(id)
    if (record === undefined) {
      const identity = await this.resolveIdentity(id, cwd, signal).catch(() => null)
      if (identity !== null && identity.delegationId !== null) record = this.records.get(identity.delegationId)
      if (record === undefined && identity !== null && identity.sessionFile !== null && existsSync(identity.sessionFile)) {
        return { sessionId: identity.sessionId ?? id, file: identity.sessionFile, events: readSessionFileEvents(identity.sessionFile, limit) }
      }
    }
    if (record !== undefined) return { delegation: delegationView(record), events: readEvents(record, limit) }
    throw new Error(`unknown delegation or session id "${id}"`)
  }

  /** The /prime/api/state payload (no CLI subprocess). */
  state(): PrimeState {
    return {
      generatedAt: new Date().toISOString(),
      bin: this.config.bin,
      delegations: this.delegations(),
      sessions: listPrimeSessions().sessions.slice(0, 20),
      generations: this.generations,
    }
  }

  /** Start one background prime-agent JSON-mode session. */
  async delegate(req: PrimeDelegateRequest): Promise<PrimeDelegation> {
    if (typeof req.task !== 'string' || req.task.trim().length === 0) {
      throw new Error('prime_agent delegate: "task" is required and must be a non-empty string')
    }
    requirePositiveInt('goalTokenBudget', req.goalTokenBudget)
    requirePositiveInt('autonomousMaxTurns', req.autonomousMaxTurns)
    requirePositiveInt('autonomousMaxTokens', req.autonomousMaxTokens)
    requirePositiveInt('autonomousTimeoutMs', req.autonomousTimeoutMs)
    requirePositiveInt('autonomousGateRetries', req.autonomousGateRetries)
    requirePositiveInt('autonomousGateTimeoutMs', req.autonomousGateTimeoutMs)
    requirePositiveInt('autonomousMaxContinuations', req.autonomousMaxContinuations)
    const running = [...this.records.values()].filter(record => record.status === 'running').length
    const max = this.config.maxDelegations
    if (running >= max) {
      throw new Error(`prime_agent delegate: ${running} delegations already running (max ${max}); stop or collect some first`)
    }
    const cwd = typeof req.cwd === 'string' && req.cwd.length > 0 ? req.cwd : process.cwd()
    const model = str(req.model) ?? str(this.config.defaultModel)
    const provider = str(req.provider) ?? str(this.config.defaultProvider)
    const thinking = str(req.thinking) ?? str(this.config.defaultThinking)
    const effective: PrimeDelegateRequest & { cwd: string } = {
      ...req,
      cwd,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(req.goalTokenBudget === undefined ? { goalTokenBudget: this.config.defaultGoalTokenBudget } : {}),
      ...(req.autonomous === undefined ? { autonomous: this.config.defaultAutonomous } : {}),
      ...(req.autonomousMaxContinuations === undefined ? { autonomousMaxContinuations: this.config.defaultAutonomousMaxContinuations } : {}),
    }
    const record = startDelegation(this, effective)
    return delegationView(record)
  }

  /** Stop one delegation (SIGTERM) or fall back to `prime-agent stop <id>`. */
  async stop(id: string, signal?: AbortSignal): Promise<PrimeStopResult> {
    if (typeof id !== 'string' || id.length === 0) throw new Error('prime_agent stop: "id" is required')
    let record = this.records.get(id)
    if (record === undefined) {
      // A delegation's underlying session id also addresses its record.
      for (const candidate of this.records.values()) {
        if (candidate.sessionId === id) {
          record = candidate
          break
        }
      }
    }
    if (record !== undefined) {
      const stopped = stopDelegation(record)
      return { action: 'stop', id, ok: true, stopped, delegation: delegationView(record) }
    }
    // CLI fallback: resolve any id form (full session id, session name) to
    // the daemon active session id the `stop` command accepts.
    const identity = await this.resolveIdentity(id, process.cwd(), signal, { allowUnresolved: true })
    const result = await runCli(this.config, ['stop', identity.activeSessionId ?? id], process.cwd(), signal, 60000)
    return { action: 'stop', id, ok: result.ok, output: result.output }
  }

  /** The full tool action dispatch, excluding `delegate`/`stop`. */
  async execute(action: Exclude<PrimeAction, 'delegate' | 'stop'>, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd()
    // Uniform agent identity: every action that takes "agent" accepts any id
    // form (delegation id, daemon active session id, full session id or
    // unique prefix, or session name) and is resolved here to the daemon
    // active session id the daemon commands need.
    if (typeof args.agent === 'string' && args.agent.length > 0) {
      const resolved = await this.resolveAgentArg(args.agent, cwd, signal)
      if (resolved !== args.agent) args = { ...args, agent: resolved }
    }
    switch (action) {
      case 'status': {
        const daemon = await runCli(this.config, ['status'], cwd, signal, 30000)
        const agents = await runCli(this.config, ['agents'], cwd, signal, 30000)
        return {
          action: 'status',
          daemon: daemon.output,
          agents: agents.output,
          delegations: [...this.records.values()].map(delegationView),
        }
      }
      case 'events': {
        if (typeof args.id !== 'string' || args.id.length === 0) throw new Error('prime_agent events: "id" is required')
        const limit = Math.min(Math.max(typeof args.limit === 'number' ? args.limit : 20, 1), 100)
        // Any id form: an in-process delegation record, a delegation's session
        // id, or a session file started outside this orchestrator.
        return { action: 'events', ...(await this.resolveEvents(args.id, cwd, limit, signal)) }
      }
      case 'sessions': {
        return { action: 'sessions', ...listPrimeSessions() }
      }
      case 'doctor': {
        const doctor = await runCli(this.config, ['doctor'], cwd, signal, 60000)
        const status = await runCli(this.config, ['status'], cwd, signal, 30000)
        return {
          action: 'doctor',
          ok: doctor.ok && status.ok,
          doctor: doctor.output,
          status: status.output,
        }
      }
      case 'goal': {
        if (typeof args.id !== 'string' || args.id.length === 0) {
          throw new Error('prime_agent goal: "id" (any prime-agent id form) is required')
        }
        const identity = await this.resolveIdentity(args.id, cwd, signal)
        const view = this.inspectIdentitySession(identity, args.id, 0)
        return {
          action: 'goal',
          id: view.id,
          goal: view.goal,
          goalContext: view.goalContext,
          lastSlashCommandResult: view.lastSlashCommandResult,
          lastCompaction: view.lastCompaction,
          idle: view.idle,
          lastActivityType: view.lastActivityType,
          file: view.file,
        }
      }
      case 'session': {
        if (typeof args.id !== 'string' || args.id.length === 0) {
          throw new Error('prime_agent session: "id" (any prime-agent id form) is required')
        }
        const identity = await this.resolveIdentity(args.id, cwd, signal)
        const limit = Math.min(Math.max(typeof args.limit === 'number' ? args.limit : 30, 1), 200)
        return { action: 'session', ...this.inspectIdentitySession(identity, args.id, limit) }
      }
      case 'send': {
        if (typeof args.id !== 'string' || args.id.length === 0) throw new Error('prime_agent send: "id" (session/agent) is required')
        if (typeof args.message !== 'string' || args.message.length === 0) throw new Error('prime_agent send: "message" is required')
        const target = await this.resolveAgentArg(args.id, cwd, signal)
        const argv = ['send']
        if (typeof args.from === 'string' && args.from.length > 0) argv.push('--from', args.from)
        if (args.delivery === 'follow_up') argv.push('--follow-up')
        else if (args.delivery === 'steer') argv.push('--steer')
        argv.push(target, args.message)
        const result = await runCli(this.config, argv, cwd, signal, 60000)
        return { action: 'send', id: target, ok: result.ok, output: result.output }
      }
      case 'send_message': {
        if (typeof args.target !== 'string' || args.target.length === 0) throw new Error('prime_agent send_message: "target" (agent name or active session id) is required')
        if (typeof args.message !== 'string' || args.message.length === 0) throw new Error('prime_agent send_message: "message" is required')
        const targetActiveSessionId = await this.resolveAgentArg(args.target, cwd, signal)
        const fromActiveSessionId = typeof args.from === 'string' && args.from.length > 0
          ? await this.resolveAgentArg(args.from, cwd, signal)
          : undefined
        const deliveryMode = args.delivery === 'follow_up' ? 'follow_up' : 'steer'
        const result = await daemonRequest(this.config, {
          type: 'send_message',
          targetActiveSessionId,
          message: args.message,
          ...(fromActiveSessionId !== undefined ? { fromActiveSessionId } : {}),
          deliveryMode,
        }, 15000)
        if (!result.ok) throw new Error(`prime_agent send_message: ${result.output}`)
        return { action: 'send_message', ok: true, target: targetActiveSessionId, receipt: result.data }
      }
      case 'agents': {
        const all = args.all === true
        const result = await listAgents(this.config, cwd, all, signal)
        if (!result.ok) throw new Error(`prime_agent agents: ${result.output}`)
        return { action: 'agents', all, count: result.agents.length, agents: result.agents }
      }
      case 'agent_messages': {
        const op = args.agentMessagesAction
        if (typeof op !== 'string' || !['status', 'pause', 'resume', 'clear'].includes(op)) {
          throw new Error('prime_agent agent_messages: "agentMessagesAction" must be status, pause, resume, or clear')
        }
        let command: Record<string, unknown>
        if (op === 'clear') {
          if (typeof args.agent !== 'string' || args.agent.length === 0) {
            throw new Error('prime_agent agent_messages clear: "agent" (daemon active session id) is required')
          }
          command = { type: 'agent_messages_clear', activeSessionId: args.agent }
        } else if (op === 'pause') {
          command = { type: 'agent_messages_pause' }
        } else if (op === 'resume') {
          command = { type: 'agent_messages_resume' }
        } else {
          command = { type: 'agent_messages_status' }
        }
        const result = await daemonRequest(this.config, command, 10000)
        if (!result.ok) throw new Error(`prime_agent agent_messages ${op}: ${result.output}`)
        return { action: 'agent_messages', op, ...(op === 'clear' ? { cleared: result.data } : { status: result.data }) }
      }
      case 'shutdown': {
        if (args.force !== true) {
          throw new Error('prime_agent shutdown: set "force": true to confirm stopping every agent, worker, and background service')
        }
        const result = await runCli(this.config, ['shutdown', '--force'], cwd, signal, 60000)
        return { action: 'shutdown', ok: result.ok, output: result.output }
      }
      case 'heartbeats': {
        const result = await listHeartbeats(this.config)
        if (!result.ok) throw new Error(`prime_agent heartbeats: ${result.output}`)
        return { action: 'heartbeats', jobs: result.jobs }
      }
      case 'heartbeat_get': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent heartbeat_get: "agent" (daemon active session id) is required')
        }
        const identity = await this.agentIdentity(args.agent, cwd, signal)
        const result = await daemonRequest(this.config, { type: 'heartbeat_get', activeSessionId: args.agent }, 10000)
        if (!result.ok) throw new Error(`prime_agent heartbeat_get: ${result.output}`)
        const job = isRecord(result.data) ? result.data.heartbeat : undefined
        return { action: 'heartbeat_get', agent: args.agent, heartbeat: isRecord(job) ? heartbeatView(job, heartbeatExtra(identity)) : null }
      }
      case 'heartbeat_set': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent heartbeat_set: "agent" (daemon active session id) is required')
        }
        if (typeof args.schedule !== 'string' || args.schedule.trim().length === 0) {
          throw new Error('prime_agent heartbeat_set: "schedule" is required (e.g. "every 5m", "0 9 * * 1-5")')
        }
        if (typeof args.message !== 'string' || args.message.trim().length === 0) {
          throw new Error('prime_agent heartbeat_set: "message" (the recurring prompt) is required')
        }
        const identity = await this.agentIdentity(args.agent, cwd, signal)
        const source = args.source ?? 'heartbeat'
        const command: Record<string, unknown> = source === 'heartbeat'
          ? { type: 'heartbeat_set', activeSessionId: args.agent, schedule: args.schedule, prompt: args.message, ...(args.delivery !== undefined ? { deliveryMode: args.delivery } : {}) }
          : { type: 'cron_add', activeSessionId: args.agent, schedule: args.schedule, prompt: args.message }
        const result = await daemonRequest(this.config, command, 10000)
        if (!result.ok) throw new Error(`prime_agent heartbeat_set: ${result.output}`)
        const job = isRecord(result.data) ? (result.data.heartbeat ?? result.data.job) : undefined
        return { action: 'heartbeat_set', ok: true, heartbeat: heartbeatView(job, heartbeatExtra(identity)) }
      }
      case 'heartbeat_action': {
        const action = args.heartbeatAction
        if (typeof action !== 'string' || !['pause', 'resume', 'stop', 'cancel', 'clear'].includes(action)) {
          throw new Error('prime_agent heartbeat_action: "heartbeatAction" must be pause, resume, stop, cancel, or clear')
        }
        let command: Record<string, unknown>
        if (action === 'cancel') {
          if (typeof args.jobId !== 'string' || args.jobId.length === 0) throw new Error('prime_agent heartbeat_action cancel: "jobId" is required')
          command = { type: 'cron_cancel', jobId: args.jobId }
        } else if (action === 'clear') {
          if (typeof args.agent !== 'string' || args.agent.length === 0) throw new Error('prime_agent heartbeat_action clear: "agent" (daemon active session id) is required')
          command = { type: 'heartbeat_update', activeSessionId: args.agent, action: 'clear' }
        } else {
          if (typeof args.jobId !== 'string' || args.jobId.length === 0 || typeof args.agent !== 'string' || args.agent.length === 0) {
            throw new Error('prime_agent heartbeat_action: "jobId" and "agent" (daemon active session id) are required for pause/resume/stop')
          }
          command = { type: 'heartbeat_manage', activeSessionId: args.agent, jobId: args.jobId, action }
        }
        const identity = typeof args.agent === 'string' && args.agent.length > 0
          ? await this.agentIdentity(args.agent, cwd, signal)
          : null
        const result = await daemonRequest(this.config, command, 10000)
        if (!result.ok) throw new Error(`prime_agent heartbeat_action: ${result.output}`)
        const job = isRecord(result.data) ? (result.data.heartbeat ?? result.data.job) : undefined
        return { action: 'heartbeat_action', ok: true, heartbeat: isRecord(job) ? heartbeatView(job, heartbeatExtra(identity)) : null }
      }
      case 'refine': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent refine: "agent" (daemon active session id) is required')
        }
        const command: Record<string, unknown> = {
          type: 'refine',
          activeSessionId: args.agent,
          ...(typeof args.instructions === 'string' && args.instructions.length > 0 ? { instructions: args.instructions } : {}),
          ...(typeof args.rollbackId === 'string' && args.rollbackId.length > 0 ? { rollbackId: args.rollbackId } : {}),
          ...(args.global === true ? { global: true } : {}),
        }
        const result = await daemonRequest(this.config, command, 120000)
        if (!result.ok) throw new Error(`prime_agent refine: ${result.output}`)
        return { action: 'refine', ok: true, agent: args.agent, result: result.data }
      }
      case 'rename': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent rename: "agent" (daemon active session id) is required')
        }
        if (typeof args.name !== 'string' || args.name.trim().length === 0) {
          throw new Error('prime_agent rename: "name" is required')
        }
        const result = await daemonRequest(this.config, { type: 'rename', activeSessionId: args.agent, name: args.name.trim() }, 30000)
        if (!result.ok) throw new Error(`prime_agent rename: ${result.output}`)
        const renamed = isRecord(result.data) ? agentView(result.data) : null
        return { action: 'rename', ok: true, agent: args.agent, name: args.name.trim(), session: renamed }
      }
      case 'compact': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent compact: "agent" (daemon active session id) is required')
        }
        const command: Record<string, unknown> = {
          type: 'compact',
          activeSessionId: args.agent,
          ...(typeof args.instructions === 'string' && args.instructions.length > 0 ? { customInstructions: args.instructions } : {}),
        }
        const result = await daemonRequest(this.config, command, 120000)
        if (!result.ok) throw new Error(`prime_agent compact: ${result.output}`)
        return { action: 'compact', ok: true, agent: args.agent, result: result.data }
      }
      case 'wait_for_idle': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent wait_for_idle: "agent" (daemon active session id) is required')
        }
        const result = await daemonRequest(this.config, { type: 'wait_for_idle', activeSessionId: args.agent }, 300000)
        if (!result.ok) throw new Error(`prime_agent wait_for_idle: ${result.output}`)
        return { action: 'wait_for_idle', ok: true, agent: args.agent, idle: true }
      }
      case 'prompt': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent prompt: "agent" (daemon active session id) is required')
        }
        if (typeof args.message !== 'string' || args.message.trim().length === 0) {
          throw new Error('prime_agent prompt: "message" is required')
        }
        const delivery = args.delivery === 'steer' || args.delivery === 'follow_up' ? args.delivery : undefined
        return { action: 'prompt', agent: args.agent, ...(await promptDaemonSession(this.config, args.agent, args.message, delivery)) }
      }
      case 'goal_set': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent goal_set: "agent" (daemon active session id) is required')
        }
        if (typeof args.goal !== 'string' || args.goal.trim().length === 0) {
          throw new Error('prime_agent goal_set: "goal" (the persistent objective) is required')
        }
        if (args.tokenBudget !== undefined && (typeof args.tokenBudget !== 'number' || !Number.isFinite(args.tokenBudget) || args.tokenBudget <= 0)) {
          throw new Error('prime_agent goal_set: "tokenBudget" must be a positive integer')
        }
        const budget = typeof args.tokenBudget === 'number' ? Math.floor(args.tokenBudget) : undefined
        const text = budget !== undefined ? `/goal --budget ${budget} ${args.goal}` : `/goal ${args.goal}`
        const delivered = await promptDaemonSession(this.config, args.agent, text, 'follow_up')
        return { action: 'goal_set', ok: true, agent: args.agent, goal: args.goal, ...(budget !== undefined ? { tokenBudget: budget } : {}), ...delivered }
      }
      case 'goal_action': {
        const op = args.goalControlAction
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent goal_action: "agent" (daemon active session id) is required')
        }
        if (typeof op !== 'string' || !['pause', 'resume', 'clear', 'stop', 'status'].includes(op)) {
          throw new Error('prime_agent goal_action: "goalControlAction" must be pause, resume, clear, stop, or status')
        }
        const delivered = await promptDaemonSession(this.config, args.agent, `/goal ${op}`, 'follow_up')
        return { action: 'goal_action', ok: true, agent: args.agent, op, ...delivered }
      }
      case 'children': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent children: "agent" (daemon active session id) is required')
        }
        const result = await daemonRequest(this.config, { type: 'get_rlm_children', activeSessionId: args.agent }, 15000)
        if (!result.ok) throw new Error(`prime_agent children: ${result.output}`)
        const raw = isRecord(result.data) && Array.isArray(result.data.children) ? result.data.children : []
        return {
          action: 'children',
          agent: args.agent,
          count: raw.length,
          children: raw.map(rlmChildView),
        }
      }
      case 'abort': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent abort: "agent" (daemon active session id) is required')
        }
        const result = await daemonRequest(this.config, { type: 'abort', activeSessionId: args.agent }, 30000)
        if (!result.ok) throw new Error(`prime_agent abort: ${result.output}`)
        return { action: 'abort', ok: true, agent: args.agent, result: result.data }
      }
      case 'models': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent models: "agent" (daemon active session id) is required')
        }
        const result = await daemonRequest(this.config, { type: 'get_available_models', activeSessionId: args.agent }, 30000)
        if (!result.ok) throw new Error(`prime_agent models: ${result.output}`)
        const models = isRecord(result.data) && Array.isArray(result.data.models) ? result.data.models : []
        return { action: 'models', agent: args.agent, count: models.length, models: models.map(modelView) }
      }
      case 'set_model': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent set_model: "agent" (daemon active session id) is required')
        }
        const cycle = args.cycle === 'forward' || args.cycle === 'backward' ? args.cycle : undefined
        if (cycle === undefined && (typeof args.provider !== 'string' || args.provider.length === 0 || typeof args.modelId !== 'string' || args.modelId.length === 0)) {
          throw new Error('prime_agent set_model: "provider" + "modelId" (from models), or "cycle": forward|backward, is required')
        }
        const command: Record<string, unknown> = cycle === undefined
          ? { type: 'set_model', activeSessionId: args.agent, provider: args.provider, modelId: args.modelId }
          : { type: 'cycle_model', activeSessionId: args.agent, direction: cycle }
        const result = await daemonRequest(this.config, command, 60000)
        if (!result.ok) throw new Error(`prime_agent set_model: ${result.output}`)
        if (typeof args.thinkingLevel === 'string' && args.thinkingLevel.length > 0) {
          const thinking = await daemonRequest(this.config, { type: 'set_thinking_level', activeSessionId: args.agent, level: args.thinkingLevel }, 30000)
          if (!thinking.ok) throw new Error(`prime_agent set_model: model set, but thinking level failed: ${thinking.output}`)
        }
        return { action: 'set_model', agent: args.agent, ...(isRecord(result.data) ? result.data : {}), ...(typeof args.thinkingLevel === 'string' ? { thinkingLevel: args.thinkingLevel } : {}) }
      }
      case 'queue': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent queue: "agent" (daemon active session id) is required')
        }
        const result = await daemonRequest(this.config, { type: 'get_queue', activeSessionId: args.agent }, 15000)
        if (!result.ok) throw new Error(`prime_agent queue: ${result.output}`)
        const data = isRecord(result.data) ? result.data : {}
        const lane = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
        return {
          action: 'queue',
          agent: args.agent,
          steering: lane(data.steering),
          followUp: lane(data.followUp),
        }
      }
      case 'queue_action': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent queue_action: "agent" (daemon active session id) is required')
        }
        if (args.op !== 'clear' && args.op !== 'abort_clear') {
          throw new Error('prime_agent queue_action: "op" clear | abort_clear is required')
        }
        const command = args.op === 'clear'
          ? { type: 'clear_queue', activeSessionId: args.agent }
          : { type: 'abort_and_clear_queue', activeSessionId: args.agent }
        const result = await daemonRequest(this.config, command, 30000)
        if (!result.ok) throw new Error(`prime_agent queue_action: ${result.output}`)
        return { action: 'queue_action', agent: args.agent, op: args.op, ok: true }
      }
      case 'messages': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent messages: "agent" (daemon active session id) is required')
        }
        if (args.last === true) {
          const result = await daemonRequest(this.config, { type: 'get_last_assistant_text', activeSessionId: args.agent }, 15000)
          if (!result.ok) throw new Error(`prime_agent messages: ${result.output}`)
          const text = isRecord(result.data) && typeof result.data.text === 'string' ? result.data.text : undefined
          return { action: 'messages', agent: args.agent, last: true, text }
        }
        const result = await daemonRequest(this.config, { type: 'get_messages', activeSessionId: args.agent }, 30000)
        if (!result.ok) throw new Error(`prime_agent messages: ${result.output}`)
        const messages = isRecord(result.data) && Array.isArray(result.data.messages) ? result.data.messages : []
        return { action: 'messages', agent: args.agent, count: messages.length, messages: messages.map((m) => messageView(m)) }
      }
      case 'child_action': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent child_action: "agent" (daemon active session id) is required')
        }
        if (typeof args.childId !== 'string' || args.childId.length === 0) {
          throw new Error('prime_agent child_action: "childId" (from children) is required')
        }
        if (args.op !== 'cancel' && args.op !== 'delete') {
          throw new Error('prime_agent child_action: "op" cancel | delete is required')
        }
        const command = args.op === 'cancel'
          ? { type: 'cancel_rlm_child', activeSessionId: args.agent, childId: args.childId }
          : { type: 'delete_rlm_subagent', activeSessionId: args.agent, childId: args.childId }
        const result = await daemonRequest(this.config, command, 30000)
        if (!result.ok) throw new Error(`prime_agent child_action: ${result.output}`)
        return { action: 'child_action', agent: args.agent, childId: args.childId, op: args.op, ok: true }
      }
      case 'export': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent export: "agent" (daemon active session id) is required')
        }
        if (args.format !== 'html' && args.format !== 'jsonl') {
          throw new Error('prime_agent export: "format" html | jsonl is required')
        }
        // Default destination: the engine's own exports dir, not the session's
        // cwd (a daemon-created session inherits an arbitrary working dir).
        const defaultPath = args.format === 'html'
          ? join(this.rowConfig.stateDir, 'exports', `${args.agent}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`)
          : join(this.rowConfig.stateDir, 'exports', `${args.agent}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
        const command: Record<string, unknown> = {
          type: args.format === 'html' ? 'export_html' : 'export_jsonl',
          activeSessionId: args.agent,
          ...(typeof args.outputPath === 'string' && args.outputPath.length > 0 ? { outputPath: args.outputPath } : { outputPath: defaultPath }),
        }
        const result = await daemonRequest(this.config, command, 60000)
        if (!result.ok) throw new Error(`prime_agent export: ${result.output}`)
        const path = isRecord(result.data) && typeof result.data.path === 'string' ? result.data.path : undefined
        return { action: 'export', agent: args.agent, format: args.format, path }
      }
      case 'fork_points': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent fork_points: "agent" (daemon active session id) is required')
        }
        const result = await daemonRequest(this.config, { type: 'get_user_messages_for_forking', activeSessionId: args.agent }, 15000)
        if (!result.ok) throw new Error(`prime_agent fork_points: ${result.output}`)
        const raw = isRecord(result.data) && Array.isArray(result.data.messages) ? result.data.messages : []
        const forkPoints = raw.map((m) => {
          const r = asRecord(m)
          return {
            entryId: typeof r.entryId === 'string' ? r.entryId : undefined,
            text: typeof r.text === 'string' ? r.text.slice(0, 300) : undefined,
          }
        })
        return { action: 'fork_points', agent: args.agent, count: forkPoints.length, forkPoints }
      }
      case 'fork': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent fork: "agent" (daemon active session id) is required')
        }
        if (typeof args.entryId !== 'string' || args.entryId.length === 0) {
          throw new Error('prime_agent fork: "entryId" (from fork_points) is required')
        }
        const position = args.position === 'before' || args.position === 'at' ? args.position : undefined
        const result = await daemonRequest(this.config, { type: 'fork', activeSessionId: args.agent, entryId: args.entryId, ...(position === undefined ? {} : { position }) }, 60000)
        if (!result.ok) throw new Error(`prime_agent fork: ${result.output}`)
        return { action: 'fork', agent: args.agent, entryId: args.entryId, ...(position === undefined ? {} : { position }), ...(isRecord(result.data) ? result.data : {}) }
      }
      case 'rlm_depth': {
        if (typeof args.agent !== 'string' || args.agent.length === 0) {
          throw new Error('prime_agent rlm_depth: "agent" (daemon active session id) is required')
        }
        if (args.maxDepth === undefined) {
          const result = await daemonRequest(this.config, { type: 'get_rlm_max_depth_status', activeSessionId: args.agent }, 15000)
          if (!result.ok) throw new Error(`prime_agent rlm_depth: ${result.output}`)
          return { action: 'rlm_depth', agent: args.agent, ...(isRecord(result.data) ? result.data : {}) }
        }
        if (typeof args.maxDepth !== 'number' || !Number.isInteger(args.maxDepth) || args.maxDepth < 0) {
          throw new Error('prime_agent rlm_depth: "maxDepth" must be a non-negative integer')
        }
        const command: Record<string, unknown> = { type: 'set_rlm_max_depth', activeSessionId: args.agent, maxDepth: args.maxDepth }
        if (args.global === true) command.global = true
        const result = await daemonRequest(this.config, command, 30000)
        if (!result.ok) throw new Error(`prime_agent rlm_depth: ${result.output}`)
        return { action: 'rlm_depth', agent: args.agent, maxDepth: args.maxDepth, ...(args.global === true ? { global: true } : {}), ...(isRecord(result.data) ? result.data : {}) }
      }
      case 'saved_session_action': {
        if (typeof args.sessionPath !== 'string' || args.sessionPath.length === 0) {
          throw new Error('prime_agent saved_session_action: "sessionPath" (from saved_sessions) is required')
        }
        if (args.op === 'rename') {
          if (typeof args.name !== 'string' || args.name.trim().length === 0) {
            throw new Error('prime_agent saved_session_action: "name" is required for rename')
          }
          const result = await daemonRequest(this.config, { type: 'rename_saved_session', sessionPath: args.sessionPath, name: args.name.trim() }, 30000)
          if (!result.ok) throw new Error(`prime_agent saved_session_action: ${result.output}`)
          return { action: 'saved_session_action', op: 'rename', sessionPath: args.sessionPath, name: args.name.trim(), ok: true }
        }
        if (args.op === 'delete') {
          const result = await daemonRequest(this.config, { type: 'delete_saved_session', sessionPath: args.sessionPath }, 30000)
          if (!result.ok) throw new Error(`prime_agent saved_session_action: ${result.output}`)
          return { action: 'saved_session_action', op: 'delete', sessionPath: args.sessionPath, ok: true }
        }
        throw new Error('prime_agent saved_session_action: "op" rename | delete is required')
      }
      case 'saved_sessions': {
        const scope = args.scope === 'all' ? 'all' : 'current'
        const command: Record<string, unknown> = {
          type: 'list_saved_sessions',
          scope,
          cwd: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : cwd,
        }
        const result = await daemonRequest(this.config, command, 30000)
        if (!result.ok) throw new Error(`prime_agent saved_sessions: ${result.output}`)
        const sessions = isRecord(result.data) && Array.isArray(result.data.sessions) ? result.data.sessions : []
        return { action: 'saved_sessions', scope, count: sessions.length, savedSessions: sessions.map(savedSessionView) }
      }
      default:
        throw new Error(`prime_agent: unknown action "${String(action)}" (delegate|status|events|sessions|send|send_message|agents|stop|doctor|goal|session|heartbeats|heartbeat_get|heartbeat_set|heartbeat_action|agent_messages|refine|rename|compact|wait_for_idle|saved_sessions|shutdown|prompt|goal_set|goal_action|children|abort|models|set_model|queue|queue_action|messages|child_action|export|fork_points|fork|rlm_depth|saved_session_action)`)
    }
  }

  /** Record one registration step in the current mount generation. */
  private step<T>(label: string, fn: () => T): T {
    try {
      const result = fn()
      this.generation.steps.push({ label, ok: true })
      return result
    } catch (error) {
      this.generation.steps.push({ label, ok: false, error: messageOf(error) })
      throw error
    }
  }

  /** Project a settings section into the public config field order, deep-frozen. */
  private toConfig(value: PrimeSettings): PrimeConfig {
    return deepFreeze({
      bin: value.bin.length > 0 ? value.bin : this.rowConfig.bin,
      stateDir: value.stateDir.length > 0 ? value.stateDir : this.rowConfig.stateDir,
      maxDelegations: value.maxDelegations,
      daemonSocket: value.daemonSocket.length > 0 ? value.daemonSocket : this.rowConfig.daemonSocket,
      defaultModel: value.delegateModel.length > 0 ? value.delegateModel : null,
      defaultProvider: value.delegateProvider.length > 0 ? value.delegateProvider : null,
      defaultThinking: value.delegateThinking.length > 0 ? value.delegateThinking : null,
      defaultGoalTokenBudget: value.delegateGoalTokenBudget,
      defaultAutonomous: value.delegateAutonomous,
      defaultAutonomousMaxContinuations: value.delegateAutonomousMaxContinuations,
    })
  }

  /** Dashboard/API dispatcher for the /prime route prefix. */
  private async handleWeb(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/prime', 'http://localhost')
    try {
      if (url.pathname === '/prime' || url.pathname === '/prime/') {
        res.writeHead(302, { location: '/' })
        res.end()
        return
      }
      if (url.pathname === '/prime/api/state' && req.method === 'GET') {
        sendJson(res, 200, this.state())
        return
      }
      if (url.pathname === '/prime/api/agents' && req.method === 'GET') {
        const all = url.searchParams.get('all') === '1'
        const argv = all ? ['list', '--all', '--json'] : ['list', '--json']
        const result = await runCli(this.config, argv, process.cwd(), undefined, 30000, 5_000_000)
        if (!result.ok) {
          sendJson(res, 500, { ok: false, error: result.output })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(result.output)
        } catch {
          sendJson(res, 500, { ok: false, error: 'prime-agent list --json returned non-JSON output' })
          return
        }
        const sessions = isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : []
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), all, agents: sessions.map(agentView) })
        return
      }
      if (url.pathname === '/prime/api/delegate' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.task !== 'string' || body.task.trim().length === 0) {
          sendJson(res, 400, { ok: false, error: '"task" is required' })
          return
        }
        for (const [name, value] of [
          ['goalTokenBudget', body.goalTokenBudget],
          ['autonomousMaxTurns', body.autonomousMaxTurns],
          ['autonomousMaxTokens', body.autonomousMaxTokens],
          ['autonomousTimeoutMs', body.autonomousTimeoutMs],
          ['autonomousGateRetries', body.autonomousGateRetries],
          ['autonomousGateTimeoutMs', body.autonomousGateTimeoutMs],
          ['autonomousMaxContinuations', body.autonomousMaxContinuations],
        ]) {
          if (value !== undefined && int(value) === undefined) {
            sendJson(res, 400, { ok: false, error: `"${name}" must be a positive integer` })
            return
          }
        }
        try {
          const delegation = await this.delegate(body as unknown as PrimeDelegateRequest)
          sendJson(res, 200, { ok: true, delegation })
        } catch (error) {
          if (error instanceof PrimeDelegationStartError) {
            sendJson(res, 500, { ok: false, delegation: error.delegation })
          } else {
            throw error
          }
        }
        return
      }
      if (url.pathname === '/prime/api/stop' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.id !== 'string' || body.id.length === 0) {
          sendJson(res, 400, { ok: false, error: '"id" is required' })
          return
        }
        // Any id form: delegation id, active session id, session id, or name.
        const result = await this.stop(body.id, undefined)
        if (result.delegation !== undefined) {
          sendJson(res, 200, { ok: true, stopped: result.stopped, delegation: result.delegation })
          return
        }
        sendJson(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output })
        return
      }
      if (url.pathname === '/prime/api/doctor' && req.method === 'GET') {
        const doctor = await runCli(this.config, ['doctor'], process.cwd(), undefined, 60000)
        const status = await runCli(this.config, ['status'], process.cwd(), undefined, 30000)
        sendJson(res, 200, { ok: doctor.ok && status.ok, doctor: doctor.output, status: status.output })
        return
      }
      if (url.pathname === '/prime/api/events' && req.method === 'GET') {
        const id = url.searchParams.get('id')
        if (!id) {
          sendJson(res, 400, { ok: false, error: '"id" query parameter is required' })
          return
        }
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 100)
        try {
          // Any id form: delegation id, session id, active session id, or name.
          sendJson(res, 200, { ok: true, ...(await this.resolveEvents(id, process.cwd(), limit)) })
        } catch (error) {
          sendJson(res, 404, { ok: false, error: messageOf(error) })
        }
        return
      }
      if (url.pathname === '/prime/api/goal' && req.method === 'GET') {
        const id = url.searchParams.get('id')
        if (!id) {
          sendJson(res, 400, { ok: false, error: '"id" query parameter is required' })
          return
        }
        try {
          // Any id form: active session id, session id, delegation id, or name.
          const identity = await this.resolveIdentity(id, process.cwd(), undefined)
          const view = this.inspectIdentitySession(identity, id, 0)
          sendJson(res, 200, {
            ok: true, id: view.id, goal: view.goal, goalContext: view.goalContext,
            lastSlashCommandResult: view.lastSlashCommandResult, lastCompaction: view.lastCompaction,
            idle: view.idle, lastActivityType: view.lastActivityType, file: view.file,
          })
        } catch (error) {
          sendJson(res, 404, { ok: false, error: messageOf(error) })
        }
        return
      }
      if (url.pathname === '/prime/api/send' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.id !== 'string' || body.id.length === 0) {
          sendJson(res, 400, { ok: false, error: '"id" (session/agent) is required' })
          return
        }
        if (typeof body.message !== 'string' || body.message.length === 0) {
          sendJson(res, 400, { ok: false, error: '"message" is required' })
          return
        }
        const target = await this.resolveAgentArg(body.id, process.cwd(), undefined)
        const result = await runCli(this.config, ['send', target, body.message], process.cwd(), undefined, 60000)
        sendJson(res, result.ok ? 200 : 500, { ok: result.ok, id: target, output: result.output })
        return
      }
      if (url.pathname === '/prime/api/shutdown' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        const argv = body.force === true ? ['shutdown', '--force'] : ['shutdown']
        const result = await runCli(this.config, argv, process.cwd(), undefined, 60000)
        sendJson(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output })
        return
      }
      if (url.pathname === '/prime/api/session' && req.method === 'GET') {
        const id = url.searchParams.get('id')
        if (!id) {
          sendJson(res, 400, { ok: false, error: '"id" query parameter is required' })
          return
        }
        try {
          // Any id form: active session id, session id, delegation id, or name.
          const identity = await this.resolveIdentity(id, process.cwd(), undefined)
          sendJson(res, 200, { ok: true, ...this.inspectIdentitySession(identity, id, 30) })
        } catch (error) {
          sendJson(res, 404, { ok: false, error: messageOf(error) })
        }
        return
      }
      if (url.pathname === '/prime/api/heartbeats' && req.method === 'GET') {
        const result = await listHeartbeats(this.config)
        sendJson(res, result.ok ? 200 : 502, result.ok
          ? { ok: true, generatedAt: new Date().toISOString(), jobs: result.jobs }
          : { ok: false, error: result.output })
        return
      }
      if (url.pathname === '/prime/api/heartbeats/set' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.agent !== 'string' || body.agent.length === 0) {
          sendJson(res, 400, { ok: false, error: '"agent" (daemon active session id) is required' })
          return
        }
        if (typeof body.schedule !== 'string' || body.schedule.trim().length === 0) {
          sendJson(res, 400, { ok: false, error: '"schedule" is required (e.g. "every 5m", "0 9 * * 1-5", "in 30m", "at <ISO date>")' })
          return
        }
        if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
          sendJson(res, 400, { ok: false, error: '"prompt" is required' })
          return
        }
        if (body.delivery !== undefined && body.delivery !== 'steer' && body.delivery !== 'follow_up') {
          sendJson(res, 400, { ok: false, error: '"delivery" must be "steer" or "follow_up"' })
          return
        }
        if (body.source !== undefined && body.source !== 'heartbeat' && body.source !== 'cron') {
          sendJson(res, 400, { ok: false, error: '"source" must be "heartbeat" or "cron"' })
          return
        }
        const agent = await this.resolveAgentArg(body.agent, process.cwd(), undefined)
        const identity = await this.agentIdentity(agent, process.cwd(), undefined)
        const source = body.source ?? 'heartbeat'
        const command: Record<string, unknown> = source === 'heartbeat'
          ? { type: 'heartbeat_set', activeSessionId: agent, schedule: body.schedule, prompt: body.prompt, ...(body.delivery !== undefined ? { deliveryMode: body.delivery } : {}) }
          : { type: 'cron_add', activeSessionId: agent, schedule: body.schedule, prompt: body.prompt }
        const result = await daemonRequest(this.config, command, 10000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        const job = isRecord(result.data) ? (result.data.heartbeat ?? result.data.job) : undefined
        sendJson(res, 200, { ok: true, agent, heartbeat: heartbeatView(job, heartbeatExtra(identity)) })
        return
      }
      if (url.pathname === '/prime/api/heartbeats/action' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        const action = body.action
        if (typeof action !== 'string' || !['pause', 'resume', 'stop', 'cancel', 'clear'].includes(action)) {
          sendJson(res, 400, { ok: false, error: '"action" must be one of pause, resume, stop, cancel, clear' })
          return
        }
        let command: Record<string, unknown>
        if (action === 'cancel') {
          if (typeof body.jobId !== 'string' || body.jobId.length === 0) {
            sendJson(res, 400, { ok: false, error: '"jobId" is required for cancel' })
            return
          }
          command = { type: 'cron_cancel', jobId: body.jobId }
        } else if (action === 'clear') {
          if (typeof body.agent !== 'string' || body.agent.length === 0) {
            sendJson(res, 400, { ok: false, error: '"agent" (any resolvable session id) is required for clear' })
            return
          }
          command = { type: 'heartbeat_update', activeSessionId: await this.resolveAgentArg(body.agent, process.cwd(), undefined), action: 'clear' }
        } else {
          if (typeof body.jobId !== 'string' || body.jobId.length === 0 || typeof body.agent !== 'string' || body.agent.length === 0) {
            sendJson(res, 400, { ok: false, error: '"jobId" and "agent" (any resolvable session id) are required for pause/resume/stop' })
            return
          }
          command = { type: 'heartbeat_manage', activeSessionId: await this.resolveAgentArg(body.agent, process.cwd(), undefined), jobId: body.jobId, action }
        }
        const result = await daemonRequest(this.config, command, 10000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        const job = isRecord(result.data) ? (result.data.heartbeat ?? result.data.job) : undefined
        sendJson(res, 200, { ok: true, heartbeat: isRecord(job) ? heartbeatView(job, {}) : null })
        return
      }
      if (url.pathname === '/prime/api/heartbeats/get' && req.method === 'GET') {
        const rawAgent = url.searchParams.get('agent')
        if (!rawAgent) {
          sendJson(res, 400, { ok: false, error: '"agent" query parameter is required' })
          return
        }
        const agent = await this.resolveAgentArg(rawAgent, process.cwd(), undefined)
        const identity = await this.agentIdentity(agent, process.cwd(), undefined)
        const result = await daemonRequest(this.config, { type: 'heartbeat_get', activeSessionId: agent }, 10000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        const job = isRecord(result.data) ? result.data.heartbeat : undefined
        sendJson(res, 200, { ok: true, agent, heartbeat: isRecord(job) ? heartbeatView(job, heartbeatExtra(identity)) : null })
        return
      }
      if (url.pathname === '/prime/api/send_message' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.target !== 'string' || body.target.length === 0) {
          sendJson(res, 400, { ok: false, error: '"target" is required' })
          return
        }
        if (typeof body.message !== 'string' || body.message.length === 0) {
          sendJson(res, 400, { ok: false, error: '"message" is required' })
          return
        }
        if (body.delivery !== undefined && body.delivery !== 'steer' && body.delivery !== 'follow_up') {
          sendJson(res, 400, { ok: false, error: '"delivery" must be "steer" or "follow_up"' })
          return
        }
        const targetActiveSessionId = await this.resolveAgentArg(body.target, process.cwd(), undefined)
        const fromActiveSessionId = typeof body.from === 'string' && body.from.length > 0
          ? await this.resolveAgentArg(body.from, process.cwd(), undefined)
          : undefined
        const result = await daemonRequest(this.config, {
          type: 'send_message',
          targetActiveSessionId,
          message: body.message,
          ...(fromActiveSessionId !== undefined ? { fromActiveSessionId } : {}),
          deliveryMode: body.delivery ?? 'steer',
        }, 15000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        sendJson(res, 200, { ok: true, target: targetActiveSessionId, receipt: result.data })
        return
      }
      if (url.pathname === '/prime/api/agent_messages' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        const action = body.action
        if (typeof action !== 'string' || !['status', 'pause', 'resume', 'clear'].includes(action)) {
          sendJson(res, 400, { ok: false, error: '"action" must be one of status, pause, resume, clear' })
          return
        }
        let command: Record<string, unknown>
        if (action === 'clear') {
          if (typeof body.agent !== 'string' || body.agent.length === 0) {
            sendJson(res, 400, { ok: false, error: '"agent" is required for clear' })
            return
          }
          command = { type: 'agent_messages_clear', activeSessionId: await this.resolveAgentArg(body.agent, process.cwd(), undefined) }
        } else if (action === 'pause') {
          command = { type: 'agent_messages_pause' }
        } else if (action === 'resume') {
          command = { type: 'agent_messages_resume' }
        } else {
          command = { type: 'agent_messages_status' }
        }
        const result = await daemonRequest(this.config, command, 10000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        sendJson(res, 200, { ok: true, action, ...(action === 'clear' ? { cleared: result.data } : { status: result.data }) })
        return
      }
      if (url.pathname === '/prime/api/refine' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.agent !== 'string' || body.agent.length === 0) {
          sendJson(res, 400, { ok: false, error: '"agent" (any resolvable session id) is required' })
          return
        }
        const agent = await this.resolveAgentArg(body.agent, process.cwd(), undefined)
        const command: Record<string, unknown> = {
          type: 'refine',
          activeSessionId: agent,
          ...(typeof body.instructions === 'string' && body.instructions.length > 0 ? { instructions: body.instructions } : {}),
          ...(typeof body.rollbackId === 'string' && body.rollbackId.length > 0 ? { rollbackId: body.rollbackId } : {}),
          ...(body.global === true ? { global: true } : {}),
        }
        const result = await daemonRequest(this.config, command, 120000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        sendJson(res, 200, { ok: true, agent, result: result.data })
        return
      }
      if (url.pathname === '/prime/api/rename' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.agent !== 'string' || body.agent.length === 0) {
          sendJson(res, 400, { ok: false, error: '"agent" (any resolvable session id) is required' })
          return
        }
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          sendJson(res, 400, { ok: false, error: '"name" is required' })
          return
        }
        const agent = await this.resolveAgentArg(body.agent, process.cwd(), undefined)
        const result = await daemonRequest(this.config, { type: 'rename', activeSessionId: agent, name: body.name.trim() }, 30000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        const renamed = isRecord(result.data) ? agentView(result.data) : null
        sendJson(res, 200, { ok: true, agent, name: body.name.trim(), session: renamed })
        return
      }
      if (url.pathname === '/prime/api/compact' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.agent !== 'string' || body.agent.length === 0) {
          sendJson(res, 400, { ok: false, error: '"agent" (any resolvable session id) is required' })
          return
        }
        const agent = await this.resolveAgentArg(body.agent, process.cwd(), undefined)
        const command: Record<string, unknown> = {
          type: 'compact',
          activeSessionId: agent,
          ...(typeof body.instructions === 'string' && body.instructions.length > 0 ? { customInstructions: body.instructions } : {}),
        }
        const result = await daemonRequest(this.config, command, 120000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        sendJson(res, 200, { ok: true, agent, result: result.data })
        return
      }
      if (url.pathname === '/prime/api/wait_for_idle' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        if (typeof body.agent !== 'string' || body.agent.length === 0) {
          sendJson(res, 400, { ok: false, error: '"agent" (any resolvable session id) is required' })
          return
        }
        const agent = await this.resolveAgentArg(body.agent, process.cwd(), undefined)
        const result = await daemonRequest(this.config, { type: 'wait_for_idle', activeSessionId: agent }, 300000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        sendJson(res, 200, { ok: true, agent, idle: true })
        return
      }
      if (url.pathname === '/prime/api/saved_sessions' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'current'
        const cwdParam = url.searchParams.get('cwd')
        const result = await daemonRequest(this.config, {
          type: 'list_saved_sessions',
          scope,
          cwd: cwdParam !== null && cwdParam.length > 0 ? cwdParam : process.cwd(),
        }, 30000)
        if (!result.ok) {
          sendJson(res, 502, { ok: false, error: result.output })
          return
        }
        const sessions = isRecord(result.data) && Array.isArray(result.data.sessions) ? result.data.sessions : []
        sendJson(res, 200, { ok: true, scope, count: sessions.length, savedSessions: sessions.map(savedSessionView) })
        return
      }
      const agentParam = (name: string): unknown => {
        const value = url.searchParams.get(name)
        return value === null ? undefined : value
      }
      const actionRoute = async (action: Exclude<PrimeAction, 'delegate' | 'stop'>, args: Record<string, unknown>): Promise<void> => {
        try {
          const result = await this.execute(action, args)
          sendJson(res, 200, { ok: true, ...(isRecord(result) ? result : {}) })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: messageOf(error) })
        }
      }
      const bodyRoute = async (action: Exclude<PrimeAction, 'delegate' | 'stop'>): Promise<void> => {
        await actionRoute(action, (await readBody(req)) as Record<string, unknown>)
      }
      if (url.pathname === '/prime/api/messages' && req.method === 'GET') {
        await actionRoute('messages', {
          agent: agentParam('agent'),
          ...(url.searchParams.get('last') === '1' ? { last: true } : {}),
        })
        return
      }
      if (url.pathname === '/prime/api/queue' && req.method === 'GET') {
        await actionRoute('queue', { agent: agentParam('agent') })
        return
      }
      if (url.pathname === '/prime/api/models' && req.method === 'GET') {
        await actionRoute('models', { agent: agentParam('agent') })
        return
      }
      if (url.pathname === '/prime/api/children' && req.method === 'GET') {
        await actionRoute('children', { agent: agentParam('agent') })
        return
      }
      if (url.pathname === '/prime/api/rlm_depth' && req.method === 'GET') {
        await actionRoute('rlm_depth', { agent: agentParam('agent') })
        return
      }
      if (url.pathname === '/prime/api/export' && req.method === 'GET') {
        await actionRoute('export', { agent: agentParam('agent'), format: agentParam('format') })
        return
      }
      if (url.pathname === '/prime/api/prompt' && req.method === 'POST') { await bodyRoute('prompt'); return }
      if (url.pathname === '/prime/api/goal_set' && req.method === 'POST') { await bodyRoute('goal_set'); return }
      if (url.pathname === '/prime/api/goal_action' && req.method === 'POST') { await bodyRoute('goal_action'); return }
      if (url.pathname === '/prime/api/queue_action' && req.method === 'POST') { await bodyRoute('queue_action'); return }
      if (url.pathname === '/prime/api/set_model' && req.method === 'POST') { await bodyRoute('set_model'); return }
      if (url.pathname === '/prime/api/abort' && req.method === 'POST') { await bodyRoute('abort'); return }
      if (url.pathname === '/prime/api/rlm_depth' && req.method === 'POST') { await bodyRoute('rlm_depth'); return }
      if (url.pathname === '/prime/api/child_action' && req.method === 'POST') { await bodyRoute('child_action'); return }
      if (url.pathname === '/prime/api/saved_session_action' && req.method === 'POST') { await bodyRoute('saved_session_action'); return }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }
}

export default PrimeOrchestration
