/**
 * Public TypeScript surface of the host-plane Prime Orchestration service.
 * Types only — no runtime code.
 * @module dsh-prime-orchestrator/types
 */

/** Live-resolved configuration: schema defaults, row config, then the user layer. */
export interface PrimeConfig {
  bin: string
  stateDir: string
  maxDelegations: number
  daemonSocket: string | null
  defaultModel: string | null
  defaultProvider: string | null
  defaultThinking: string | null
  defaultGoalTokenBudget: number
  defaultAutonomous: boolean
  defaultAutonomousMaxContinuations: number
}

/** Public view of one delegation (no live process handles). */
export interface PrimeDelegation {
  id: string
  task: string
  cwd: string
  /** The underlying prime-agent session id once the log's session header arrived. */
  sessionId: string | null
  /** The daemon active session id once the delegation is daemon-backed (null for subprocess delegations today). */
  activeSessionId: string | null
  pid: number | null
  status: 'running' | 'exited' | 'failed' | 'stopped'
  startedAt: string
  endedAt: string | null
  exitCode: number | null
  lastEventType: string | null
  lastText: string | null
  completed: boolean
  error: string | null
  logFile: string
}

/** One prime-agent persisted session file with recency metadata. */
export interface PrimeSessionFile {
  id: string
  file: string
  sizeBytes: number
  modifiedAt: string
}

/** One registration step in a service mount generation. */
export interface PrimeGenerationStep {
  label: string
  ok: boolean
  error?: string
}

/** One service mount generation, kept so superseded generations stay observable. */
export interface PrimeGeneration {
  id: string
  mountedAt: string
  steps: PrimeGenerationStep[]
}

/** The /prime/api/state payload (no CLI subprocess). */
export interface PrimeState {
  generatedAt: string
  bin: string
  /** Every delegation started in this process, newest first. */
  delegations: PrimeDelegation[]
  /** Top 20 persisted sessions by modification time. */
  sessions: PrimeSessionFile[]
  /** Mount generations, as reported by the preset today. */
  generations: PrimeGeneration[]
}

/** Request for one background prime-agent JSON-mode session. */
export interface PrimeDelegateRequest {
  task: string
  briefing?: string
  cwd?: string
  model?: string
  provider?: string
  thinking?: string
  offline?: boolean
  goal?: string
  goalTokenBudget?: number
  continue?: boolean
  resume?: string
  extensions?: string[]
  skills?: string[]
  appendSystemPrompt?: string[]
  daemonBacked?: boolean
  autonomous?: boolean
  autonomousGates?: string[]
  autonomousMaxTurns?: number
  autonomousMaxTokens?: number
  autonomousTimeoutMs?: number
  autonomousGateRetries?: number
  autonomousGateTimeoutMs?: number
  autonomousMaxContinuations?: number
}

/**
 * One id resolved across every prime-agent identity namespace. Any action
 * that takes a session/agent/delegation id accepts any id form and resolves
 * it through this shape before use.
 */
export interface ResolvedIdentity {
  /** The 8-char delegation record id, when the id matched an in-process delegation. */
  delegationId: string | null
  /** The daemon active session id, when the daemon roster matched. */
  activeSessionId: string | null
  /** The full session id (the `.jsonl` basename without extension). */
  sessionId: string | null
  /** The absolute `.jsonl` session file path, when one is known. */
  sessionFile: string | null
  /** The daemon session name, when the daemon roster matched. */
  sessionName: string | null
  /** Which namespace matched the input id. */
  source: 'delegation' | 'agent' | 'session-file' | 'name'
}

/** Result of {@link PrimeOrchestration.stop}. */
export interface PrimeStopResult {
  action: 'stop'
  id: string
  ok: boolean
  stopped?: boolean
  delegation?: PrimeDelegation
  output?: string
}

/** Tool actions dispatched by the service. */
export type PrimeAction = 'delegate' | 'status' | 'events' | 'sessions' | 'send'
  | 'send_message' | 'agents' | 'stop' | 'doctor' | 'goal' | 'session'
  | 'heartbeats' | 'heartbeat_get' | 'heartbeat_set' | 'heartbeat_action'
  | 'agent_messages' | 'refine' | 'rename' | 'compact' | 'wait_for_idle'
  | 'saved_sessions' | 'shutdown' | 'prompt' | 'goal_set' | 'goal_action'
  | 'children' | 'abort'
  | 'models' | 'set_model' | 'queue' | 'queue_action' | 'messages'
  | 'child_action' | 'export' | 'fork_points' | 'fork' | 'rlm_depth'
  | 'saved_session_action'
