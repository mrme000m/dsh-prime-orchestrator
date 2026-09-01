/**
 * Prime Orchestrator HTTP client: the typed same-origin face over the
 * preset plugin's `/prime/api/*` routes. Pure fetch wrapper — no framework
 * imports, no state; apply mints one instance and injects it into the
 * panel entry. Wire shapes here mirror the preset's `delegationView` /
 * `inspectSession` projections verbatim (the JSON boundary IS the contract;
 * drift surfaces as undefined fields, never as a thrown parse).
 */

/** One harness-started delegation: a background `prime-agent --mode json` child. */
export interface PrimeDelegation {
  id: string
  task: string
  cwd: string
  /** The underlying prime-agent session id once the log's session header arrived (steering target). */
  sessionId: string | null
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

/** One of prime-agent's own persisted session files (~/.prime/agent/sessions). */
export interface PrimeSessionFile {
  id: string
  file: string
  sizeBytes: number
  modifiedAt: string
}

/** GET /prime/api/state — the fast roster snapshot (no CLI subprocess). */
export interface PrimeState {
  generatedAt: string
  bin: string
  delegations: PrimeDelegation[]
  sessions: PrimeSessionFile[]
}

/**
 * One daemon-managed or saved prime-agent session, projected by the preset's
 * agentView: display facts only (no model wiring, no live handles). Saved
 * (draft) sessions carry fewer facts; every field beyond the booleans and
 * counts is null when the daemon omitted it. Never assume presence — check
 * each nullable field before display.
 */
export interface PrimeAgent {
  /** Agent id: short for the live top-level agent, the session uuid for saved ones. */
  id: string | null
  /** The daemon session id — the steering and session-inspection target. */
  sessionId: string | null
  /** The on-disk JSONL backing this agent (authoritative for inspection). */
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  /** The session's first message — the closest thing to a name the daemon reports. */
  firstMessage: string | null
  /** Display name of the bound model, or null. */
  model: string | null
  /** Model id of the bound model, or null. */
  modelId: string | null
  /** Reasoning level ('off' … 'max'), or null. */
  thinking: string | null
  /** 'live' for a real session, 'draft' for a saved/empty one. */
  lifecycle: string | null
  /** Daemon activity vocabulary: 'working' or 'idle'. */
  activity: string | null
  /** True when a daemon worker owns this session (vs a saved draft). */
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
  /** AgentTaskState value ('needs_input' while waiting), or null. */
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

/** GET /prime/api/agents — the projected daemon roster. */
export interface PrimeAgents {
  ok: boolean
  generatedAt: string
  all: boolean
  agents: PrimeAgent[]
}

/**
 * One daemon heartbeat or scheduled prompt, projected by the preset's
 * heartbeatView. Heartbeats are per-session recurring prompts (source
 * heartbeat/rlm_heartbeat, deliveryMode steer/follow_up); cron rows are
 * plain scheduled prompts. Nullable fields are absent from the daemon's
 * record, not guaranteed missing — check before display.
 */
export interface PrimeHeartbeat {
  id: string | null
  /** 'active' | 'paused' | 'completed' | 'cancelled'. */
  status: string | null
  /** 'heartbeat' | 'rlm_heartbeat' (nested, subagent-owned) | 'cron'. */
  source: string | null
  /** 'top-level' | 'subagent' — the owning session's runtime kind. */
  runtimeKind: string | null
  /** 'steer' interrupts a busy session; 'follow_up' queues after the turn. */
  deliveryMode: string | null
  /** Daemon active session id owning the job (the management target). */
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

/** GET /prime/api/heartbeats — the projected heartbeat + scheduled-prompt catalog. */
export interface PrimeHeartbeats {
  ok: boolean
  generatedAt: string
  jobs: PrimeHeartbeat[]
}

/** POST /prime/api/heartbeats/set — create a heartbeat or scheduled prompt. */
export interface PrimeHeartbeatSetInput {
  /** Daemon active session id of the target session (subagent ids create nested heartbeats). */
  agent: string
  /** 'every 5m', a cron expression, 'in 30m', or 'at <ISO date>'. */
  schedule: string
  prompt: string
  /** Busy-session delivery: 'steer' interrupts, 'follow_up' queues (default steer). */
  delivery?: 'steer' | 'follow_up'
  /** 'heartbeat' (persistent recurring prompt) or 'cron' (plain scheduled prompt). */
  source?: 'heartbeat' | 'cron'
}

/** POST /prime/api/heartbeats/action — one management operation. */
export interface PrimeHeartbeatActionInput {
  action: 'pause' | 'resume' | 'stop' | 'cancel' | 'clear'
  /** Required for pause/resume/stop/clear — the owning session's active id. */
  agent?: string | undefined
  /** Required for pause/resume/stop/cancel — the job id. */
  jobId?: string | undefined
}

/** Both heartbeat mutations resolve to the projected job (null when none remains). */
export interface PrimeHeartbeatMutation {
  ok: boolean
  heartbeat: PrimeHeartbeat | null
}

/** GET /prime/api/heartbeats/get — one session's current persistent heartbeat. */
export interface PrimeHeartbeatGetResult {
  ok: boolean
  agent: string
  heartbeat: PrimeHeartbeat | null
}

/** POST /prime/api/send_message — agent-to-agent message delivery. */
export interface PrimeSendMessageInput {
  /** Agent name, short agent id, or session id to deliver to. */
  target: string
  message: string
  /** Optional sender agent/session id. */
  from?: string
  /** 'steer' interrupts a busy target; 'follow_up' queues after its turn (default steer). */
  delivery?: 'steer' | 'follow_up'
}

/** The daemon's delivery receipt for one agent-to-agent message. */
export interface PrimeSendMessageReceipt {
  id: string
  message: string
  deliveryStatus: 'delivered' | 'queued'
  deliveredAt?: string | null
  queuedAt?: string | null
  deliveryMode?: 'steer' | null
}

/** POST /prime/api/send_message — the resolved target plus its receipt. */
export interface PrimeSendMessageResult {
  ok: boolean
  target: string
  receipt: PrimeSendMessageReceipt
}

/** POST /prime/api/agent_messages — inbox safety state or a management result. */
export interface PrimeAgentMessagesInput {
  action: 'status' | 'pause' | 'resume' | 'clear'
  /** Required for clear — the target session's daemon active session id. */
  agent?: string
}

/** The daemon's agent-message inbox safety state (status/pause/resume). */
export interface PrimeAgentMessagesStatus {
  paused: boolean
  maxMessageChars: number
  maxPendingPerSession: number
  rateLimitCapacity: number
  rateLimitRefillMs: number
}

export interface PrimeAgentMessagesResult {
  ok: boolean
  action: string
  status?: PrimeAgentMessagesStatus
  cleared?: unknown
}

/** One saved (draft) prime-agent session, projected by the preset's savedSessionView. */
export interface PrimeSavedSession {
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

/** GET /prime/api/saved_sessions — the daemon's saved-session list. */
export interface PrimeSavedSessionsResult {
  ok: boolean
  scope: 'current' | 'all'
  count: number
  savedSessions: PrimeSavedSession[]
}

/** POST /prime/api/refine — run /refine on a session (harness self-improvement). */
export interface PrimeRefineInput {
  agent: string
  instructions?: string
  rollbackId?: string
  global?: boolean
}

export interface PrimeRefineResult {
  ok: boolean
  agent: string
  result: unknown
}

/** POST /prime/api/rename — set a session's name. */
export interface PrimeRenameInput {
  agent: string
  name: string
}

export interface PrimeRenameResult {
  ok: boolean
  agent: string
  name: string
  session: PrimeAgent | null
}

/** POST /prime/api/compact — compact a session's context now. */
export interface PrimeCompactInput {
  agent: string
  instructions?: string
}

export interface PrimeCompactResult {
  ok: boolean
  agent: string
  result: unknown
}

/** POST /prime/api/wait_for_idle — block until a session reaches its idle state. */
export interface PrimeWaitForIdleResult {
  ok: boolean
  agent: string
  idle: boolean
}

/** One summarized trailing event of a delegation log or session file. */
export interface PrimeEventSummary {
  type: string
  role?: string
  text?: string
  toolCalls?: string[]
  /** custom_message subtype: goal_context, session_slash_command(_result), heartbeat_prompt, … */
  customType?: string | null
  /** tool_execution_* tool name. */
  toolName?: string
  /** tool_execution_* call id. */
  toolCallId?: string
  /** tool_execution_end wall duration in ms. */
  durationMs?: number | null
  /** tool_execution_end outcome ('ok', …). */
  toolStatus?: string | null
  /** goal_update / thread_goal_state objective text. */
  objective?: string
  goalState?: {
    status: string | null
    goalId: string | null
    active: boolean
    tokensUsed: number | null
    timeUsedSeconds: number | null
  } | null
  needsInput?: boolean
  taskState?: string | null
  compaction?: string
}

/** GET /prime/api/session — goal-lifecycle forensics plus a trailing event window. */
export interface PrimeSessionInspection {
  id: string
  file: string
  sizeBytes: number
  modifiedAt: string
  goal: PrimeEventSummary['goalState']
  goalContext: string | null
  lastSlashCommandResult: string | null
  lastCompaction: string | null
  idle: boolean
  lastActivityType: string | null
  events: PrimeEventSummary[]
}

/** Delegate request mirroring the prime-agent CLI capability flags. */
export interface PrimeDelegateInput {
  task: string
  cwd?: string
  model?: string
  provider?: string
  thinking?: string
  goal?: string
  goalTokenBudget?: number
  continue?: boolean
  resume?: string
  extensions?: string[]
  skills?: string[]
  appendSystemPrompt?: string[]
  offline?: boolean
  autonomous?: boolean
  autonomousGates?: string[]
  autonomousMaxTurns?: number
  autonomousMaxTokens?: number
  autonomousTimeoutMs?: number
}

/** GET /prime/api/doctor — background-service health (`prime-agent doctor` + `status`). */
export interface PrimeHealth {
  ok: boolean
  doctor: string
  status: string
}

/** POST /prime/api/stop — the stopped delegation view, or the CLI fallback output. */
export interface PrimeStopResult {
  ok: boolean
  stopped?: boolean
  delegation?: PrimeDelegation
  output?: string
}

/** POST /prime/api/send — agent-to-agent steering delivery result. */
export interface PrimeSendResult {
  ok: boolean
  id: string
  output: string
}

/** One failed API call: the response's `error` field when present, else the status. */
export class PrimeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Fetch-like function type (injectable for tests; the browser supplies the real one). */
export type PrimeFetch = (input: string, init?: RequestInit) => Promise<Response>

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as { error?: unknown }
      if (typeof body.error === 'string') detail = body.error
    } catch {
      // Non-JSON error body: the status line below is the whole story.
    }
    throw new PrimeApiError(detail.length > 0 ? detail : `HTTP ${res.status}`, res.status)
  }
  return await res.json() as T
}

/**
 * Create the /prime API client.
 * @param fetchLike - fetch implementation (defaults to the global).
 * @returns the typed endpoint methods.
 */
export function createPrimeApi(fetchLike: PrimeFetch = (input, init) => fetch(input, init)): PrimeApi {
  return makePrimeApi(fetchLike)
}

/**
 * Build the endpoint methods.
 * @param fetchLike - fetch implementation.
 * @returns the typed endpoint methods.
 */
function makePrimeApi(fetchLike: PrimeFetch): PrimeApi {
  return {
    /** Probe + roster snapshot; also the availability gate for the whole plugin. */
    async state(): Promise<PrimeState> {
      return await json<PrimeState>(await fetchLike('/prime/api/state'))
    },
    /** The daemon's live agent roster; `all` adds saved (draft) agents. */
    async agents(all = false): Promise<PrimeAgents> {
      return await json<PrimeAgents>(await fetchLike(`/prime/api/agents${all ? '?all=1' : ''}`))
    },
    /** Start a delegation; rejects with the server's error on a failed spawn. */
    async delegate(input: PrimeDelegateInput): Promise<PrimeDelegation> {
      const body = await json<{ ok: boolean; delegation?: PrimeDelegation; error?: string }>(
        await fetchLike('/prime/api/delegate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }))
      if (body.delegation === undefined) {
        throw new PrimeApiError(body.error ?? 'delegation failed to start', 500)
      }
      return body.delegation
    },
    /** Stop a delegation by id, or a prime-agent session via the CLI fallback. */
    async stop(id: string): Promise<PrimeStopResult> {
      return await json<PrimeStopResult>(await fetchLike('/prime/api/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }))
    },
    /** Deliver a steering message to a running session/agent. */
    async send(id: string, message: string): Promise<PrimeSendResult> {
      return await json<PrimeSendResult>(await fetchLike('/prime/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, message }),
      }))
    },
    /** Trailing summarized events of one harness delegation. */
    async events(id: string, limit = 20): Promise<PrimeEventSummary[]> {
      const body = await json<{ events: PrimeEventSummary[] }>(
        await fetchLike(`/prime/api/events?id=${encodeURIComponent(id)}&limit=${limit}`))
      return body.events
    },
    /** Goal-lifecycle forensics plus trailing events of any prime-agent session. */
    async session(id: string, limit = 30): Promise<PrimeSessionInspection> {
      return await json<PrimeSessionInspection>(
        await fetchLike(`/prime/api/session?id=${encodeURIComponent(id)}&limit=${limit}`))
    },
    /** Background-service health (slow: shells out to `prime-agent doctor`). */
    async doctor(): Promise<PrimeHealth> {
      return await json<PrimeHealth>(await fetchLike('/prime/api/doctor'))
    },
    /** Stop every agent, worker, and background service (`prime-agent shutdown --force`). */
    async shutdown(): Promise<{ ok: boolean; output: string }> {
      return await json<{ ok: boolean; output: string }>(await fetchLike('/prime/api/shutdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      }))
    },
    /** The daemon's heartbeat + scheduled-prompt catalog. */
    async heartbeats(): Promise<PrimeHeartbeats> {
      return await json<PrimeHeartbeats>(await fetchLike('/prime/api/heartbeats'))
    },
    /** Set a persistent heartbeat (or a plain scheduled prompt) on one session. */
    async heartbeatSet(input: PrimeHeartbeatSetInput): Promise<PrimeHeartbeatMutation> {
      return await json<PrimeHeartbeatMutation>(await fetchLike('/prime/api/heartbeats/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Pause/resume/stop/cancel one job, or clear a session's persistent heartbeat. */
    async heartbeatAction(input: PrimeHeartbeatActionInput): Promise<PrimeHeartbeatMutation> {
      return await json<PrimeHeartbeatMutation>(await fetchLike('/prime/api/heartbeats/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Read one session's current persistent heartbeat. */
    async heartbeatGet(agent: string): Promise<PrimeHeartbeatGetResult> {
      return await json<PrimeHeartbeatGetResult>(
        await fetchLike(`/prime/api/heartbeats/get?agent=${encodeURIComponent(agent)}`))
    },
    /** Agent-to-agent message delivery over the daemon socket (receipt). */
    async sendMessage(input: PrimeSendMessageInput): Promise<PrimeSendMessageResult> {
      return await json<PrimeSendMessageResult>(await fetchLike('/prime/api/send_message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Read or gate the agent-message inbox (status/pause/resume/clear). */
    async agentMessages(input: PrimeAgentMessagesInput): Promise<PrimeAgentMessagesResult> {
      return await json<PrimeAgentMessagesResult>(await fetchLike('/prime/api/agent_messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Run /refine on a session (harness self-improvement). */
    async refine(input: PrimeRefineInput): Promise<PrimeRefineResult> {
      return await json<PrimeRefineResult>(await fetchLike('/prime/api/refine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Set a session's name. */
    async rename(input: PrimeRenameInput): Promise<PrimeRenameResult> {
      return await json<PrimeRenameResult>(await fetchLike('/prime/api/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Compact a session's context now. */
    async compact(input: PrimeCompactInput): Promise<PrimeCompactResult> {
      return await json<PrimeCompactResult>(await fetchLike('/prime/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Block until a session reaches its idle state. */
    async waitForIdle(agent: string): Promise<PrimeWaitForIdleResult> {
      return await json<PrimeWaitForIdleResult>(await fetchLike('/prime/api/wait_for_idle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent }),
      }))
    },
    /** List saved (draft) sessions via the daemon. */
    async savedSessions(scope: 'current' | 'all' = 'current'): Promise<PrimeSavedSessionsResult> {
      return await json<PrimeSavedSessionsResult>(
        await fetchLike(`/prime/api/saved_sessions?scope=${encodeURIComponent(scope)}`))
    },
    /** Live conversation of a running session; last=true returns only the final assistant text. */
    async messages(agent: string, last?: boolean): Promise<PrimeMessagesResult> {
      return await json<PrimeMessagesResult>(await fetchLike(
        `/prime/api/messages?agent=${encodeURIComponent(agent)}${last === true ? '&last=1' : ''}`))
    },
    /** Pending steering and follow-up lanes of a running session. */
    async queue(agent: string): Promise<PrimeQueueResult> {
      return await json<PrimeQueueResult>(await fetchLike(
        `/prime/api/queue?agent=${encodeURIComponent(agent)}`))
    },
    /** Drop queued input (clear) or also cancel the running turn (abort_clear). */
    async queueAction(agent: string, op: 'clear' | 'abort_clear'): Promise<PrimeQueueMutationResult> {
      return await json<PrimeQueueMutationResult>(await fetchLike('/prime/api/queue_action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, op }),
      }))
    },
    /** Deliver a prompt or slash command to a running session (delivery steer/follow_up/queue). */
    async prompt(input: { agent: string; message: string; delivery?: 'steer' | 'follow_up' }): Promise<PrimePromptResult> {
      return await json<PrimePromptResult>(await fetchLike('/prime/api/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Models a running session can switch to. */
    async models(agent: string): Promise<PrimeModelsResult> {
      return await json<PrimeModelsResult>(await fetchLike(
        `/prime/api/models?agent=${encodeURIComponent(agent)}`))
    },
    /** Switch a running session's model (provider+modelId or cycle). */
    async setModel(input: { agent: string; provider?: string; modelId?: string; cycle?: 'forward' | 'backward'; thinkingLevel?: string }): Promise<PrimeSetModelResult> {
      return await json<PrimeSetModelResult>(await fetchLike('/prime/api/set_model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Set a persistent goal on a running session. */
    async goalSet(input: { agent: string; goal: string; tokenBudget?: number }): Promise<PrimeGoalMutationResult> {
      return await json<PrimeGoalMutationResult>(await fetchLike('/prime/api/goal_set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
    },
    /** Manage a running session's persistent goal. */
    async goalAction(agent: string, goalControlAction: 'pause' | 'resume' | 'clear' | 'stop' | 'status'): Promise<PrimeGoalMutationResult> {
      return await json<PrimeGoalMutationResult>(await fetchLike('/prime/api/goal_action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, goalControlAction }),
      }))
    },
    /** Cancel a running session's current turn. */
    async abort(agent: string): Promise<PrimeAbortResult> {
      return await json<PrimeAbortResult>(await fetchLike('/prime/api/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent }),
      }))
    },
    /** The session's own rlm subagent rows. */
    async children(agent: string): Promise<{ ok: boolean; agent: string; count: number; children: PrimeChildRow[] }> {
      return await json<{ ok: boolean; agent: string; count: number; children: PrimeChildRow[] }>(await fetchLike(
        `/prime/api/children?agent=${encodeURIComponent(agent)}`))
    },
    /** Read (no arg) or set the session's max rlm recursion depth. */
    async rlmDepth(agent: string, maxDepth?: number): Promise<PrimeDepthResult> {
      return await json<PrimeDepthResult>(await fetchLike('/prime/api/rlm_depth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, ...(maxDepth === undefined ? {} : { maxDepth }) }),
      }))
    },
    /** Export a running session's transcript. */
    async exportSession(agent: string, format: 'html' | 'jsonl'): Promise<PrimeExportResult> {
      return await json<PrimeExportResult>(await fetchLike(
        `/prime/api/export?agent=${encodeURIComponent(agent)}&format=${format}`))
    },
  }
}

/** The delegated api face (what registration injects into the panel). */
/** One bounded conversation row from the daemon's get_messages projection. */
export interface PrimeMessageRow {
  role: string | undefined
  name: string | undefined
  tool: string | undefined
  text: string | undefined
}

/** GET /prime/api/messages — live conversation of a running session. */
export interface PrimeMessagesResult {
  ok: boolean
  action: 'messages'
  agent: string
  count?: number
  messages?: PrimeMessageRow[]
  last?: boolean
  text?: string
}

/** GET /prime/api/queue — the session's pending steering and follow-up lanes. */
export interface PrimeQueueResult {
  ok: boolean
  agent: string
  steering: string[]
  followUp: string[]
}

/** One switchable model row from the daemon catalog. */
export interface PrimeModelRow {
  provider: string | undefined
  id: string | undefined
  name: string | undefined
  reasoning: boolean
  contextWindow: number | undefined
  maxTokens: number | undefined
}

/** GET /prime/api/models — the models a running session can switch to. */
export interface PrimeModelsResult {
  ok: boolean
  agent: string
  count: number
  models: PrimeModelRow[]
}

/** POST /prime/api/prompt — deliver work or a slash command to a running session. */
export interface PrimePromptResult {
  ok: boolean
  action: 'prompt'
  agent: string
  delivered?: boolean
  disposition?: string
}

/** POST /prime/api/goal_set or goal_action. */
export interface PrimeGoalMutationResult {
  ok: boolean
  agent: string
}

/** POST /prime/api/queue_action. */
export interface PrimeQueueMutationResult {
  ok: boolean
  agent: string
  op: string
}

/** POST /prime/api/abort — cancel the running turn. */
export interface PrimeAbortResult {
  ok: boolean
  agent: string
}

/** GET /prime/api/rlm_depth — recursion depth status. */
export interface PrimeDepthResult {
  ok: boolean
  agent: string
  maxDepth?: number
  source?: string
}

/** GET /prime/api/export — transcript export receipt. */
export interface PrimeExportResult {
  ok: boolean
  agent: string
  format: string
  path: string | undefined
}

/** POST /prime/api/set_model — mid-session model switch receipt. */
export interface PrimeSetModelResult {
  ok: boolean
  action: 'set_model'
  agent: string
}

export interface PrimeApi {
  /** Probe + roster snapshot; also the availability gate for the whole plugin. */
  state(): Promise<PrimeState>
  /** The daemon's live agent roster; `all` adds saved (draft) agents. */
  agents(all?: boolean): Promise<PrimeAgents>
  /** Start a delegation; rejects with the server's error on a failed spawn. */
  delegate(input: PrimeDelegateInput): Promise<PrimeDelegation>
  /** Stop a delegation by id, or a prime-agent session via the CLI fallback. */
  stop(id: string): Promise<PrimeStopResult>
  /** Deliver a steering message to a running session/agent. */
  send(id: string, message: string): Promise<PrimeSendResult>
  /** Trailing summarized events of one harness delegation. */
  events(id: string, limit?: number): Promise<PrimeEventSummary[]>
  /** Goal-lifecycle forensics plus trailing events of any prime-agent session. */
  session(id: string, limit?: number): Promise<PrimeSessionInspection>
  /** Background-service health (slow: shells out to `prime-agent doctor`). */
  doctor(): Promise<PrimeHealth>
  /** Stop every agent, worker, and background service (`prime-agent shutdown --force`). */
  shutdown(): Promise<{ ok: boolean; output: string }>
  /** The daemon's heartbeat + scheduled-prompt catalog. */
  heartbeats(): Promise<PrimeHeartbeats>
  /** Set a persistent heartbeat (or a plain scheduled prompt) on one session. */
  heartbeatSet(input: PrimeHeartbeatSetInput): Promise<PrimeHeartbeatMutation>
  /** Pause/resume/stop/cancel one job, or clear a session's persistent heartbeat. */
  heartbeatAction(input: PrimeHeartbeatActionInput): Promise<PrimeHeartbeatMutation>
  /** Read one session's current persistent heartbeat. */
  heartbeatGet(agent: string): Promise<PrimeHeartbeatGetResult>
  /** Agent-to-agent message delivery over the daemon socket (receipt). */
  sendMessage(input: PrimeSendMessageInput): Promise<PrimeSendMessageResult>
  /** Read or gate the agent-message inbox (status/pause/resume/clear). */
  agentMessages(input: PrimeAgentMessagesInput): Promise<PrimeAgentMessagesResult>
  /** Run /refine on a session (harness self-improvement). */
  refine(input: PrimeRefineInput): Promise<PrimeRefineResult>
  /** Set a session's name. */
  rename(input: PrimeRenameInput): Promise<PrimeRenameResult>
  /** Compact a session's context now. */
  compact(input: PrimeCompactInput): Promise<PrimeCompactResult>
  /** Block until a session reaches its idle state. */
  waitForIdle(agent: string): Promise<PrimeWaitForIdleResult>
  /** List saved (draft) sessions via the daemon. */
  savedSessions(scope?: 'current' | 'all'): Promise<PrimeSavedSessionsResult>
  /** Live conversation of a running session; last=true returns only the final assistant text. */
  messages(agent: string, last?: boolean): Promise<PrimeMessagesResult>
  /** Pending steering and follow-up lanes of a running session. */
  queue(agent: string): Promise<PrimeQueueResult>
  /** Drop queued input (clear) or also cancel the running turn (abort_clear). */
  queueAction(agent: string, op: 'clear' | 'abort_clear'): Promise<PrimeQueueMutationResult>
  /** Deliver a prompt or slash command to a running session (delivery steer/follow_up/queue). */
  prompt(input: { agent: string; message: string; delivery?: 'steer' | 'follow_up' }): Promise<PrimePromptResult>
  /** Models a running session can switch to. */
  models(agent: string): Promise<PrimeModelsResult>
  /** Switch a running session's model (provider+modelId or cycle). */
  setModel(input: { agent: string; provider?: string; modelId?: string; cycle?: 'forward' | 'backward'; thinkingLevel?: string }): Promise<PrimeSetModelResult>
  /** Set a persistent goal on a running session. */
  goalSet(input: { agent: string; goal: string; tokenBudget?: number }): Promise<PrimeGoalMutationResult>
  /** Manage a running session's persistent goal. */
  goalAction(agent: string, goalControlAction: 'pause' | 'resume' | 'clear' | 'stop' | 'status'): Promise<PrimeGoalMutationResult>
  /** Cancel a running session's current turn. */
  abort(agent: string): Promise<PrimeAbortResult>
  /** The session's own rlm subagent rows. */
  children(agent: string): Promise<{ ok: boolean; agent: string; count: number; children: PrimeChildRow[] }>
  /** Read (no arg) or set the session's max rlm recursion depth. */
  rlmDepth(agent: string, maxDepth?: number): Promise<PrimeDepthResult>
  /** Export a running session's transcript. */
  exportSession(agent: string, format: 'html' | 'jsonl'): Promise<PrimeExportResult>
}

/** One rlm subagent row from the children projection. */
export interface PrimeChildRow {
  id: string | undefined
  sessionName: string | undefined
  label: string | undefined
  status: string | undefined
  model: string | undefined
  tokens: number | undefined
  replied: boolean
  answerPreview: string | undefined
}
