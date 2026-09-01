/**
 * Agent-plane Prime Agent orchestration surface over the host `ctx.prime`
 * service (`@deepseek-ai/dsh-prime-orchestration`).
 *
 * This plugin contributes the model-facing half of the Prime Agent feature:
 * the `prime_agent` delegation tool, the `prime-orchestrator:workflow` prompt
 * section, and the `prime-agent` skill. It owns no orchestration state: every
 * action dispatches to the host service, which owns the shared delegation
 * table, the `/prime` web prefix, and the `prime` settings namespace.
 * @module dsh-prime-orchestrator/agent-tool
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PrimeAction, PrimeDelegateRequest } from './engine-types.ts'
// Type-only: merges `Context.systemPrompt` for the workflow section.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: merges `Context.skills` for the runtime skill registration.
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'prime-agent-tool'

/** Hard service dependencies. `prime` is the host-plane orchestration service. */
export const inject = ['tools', 'systemPrompt', 'skills', 'prime']

/** Prompt order: after the persona and before the per-tool guidance band. */
const WORKFLOW_SECTION_ORDER = 60

/** The complete set of `prime_agent` actions, mirroring {@link PrimeAction}. */
const PRIME_ACTIONS = [
  'delegate', 'status', 'events', 'sessions', 'send', 'send_message',
  'agents', 'stop', 'doctor', 'goal', 'session', 'heartbeats',
  'heartbeat_get', 'heartbeat_set', 'heartbeat_action', 'agent_messages',
  'refine', 'rename', 'compact', 'wait_for_idle', 'saved_sessions', 'shutdown',
] as const

/** Plugin config: the model-facing tool name, overridable for distinct instances. */
export interface Config {
  /** Model-facing tool name (default `prime_agent`). */
  toolName?: string
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('prime_agent'),
})

/** Typed view of the `prime_agent` tool's open parameter object. */
interface PrimeAgentArgs {
  action: PrimeAction
  task?: string
  cwd?: string
  id?: string
  message?: string
  limit?: number
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
  schedule?: string
  delivery?: 'steer' | 'follow_up'
  source?: 'heartbeat' | 'cron'
  agent?: string
  jobId?: string
  heartbeatAction?: 'pause' | 'resume' | 'stop' | 'cancel' | 'clear'
  target?: string
  from?: string
  agentMessagesAction?: 'status' | 'pause' | 'resume' | 'clear'
  all?: boolean
  force?: boolean
  autonomousGateRetries?: number
  autonomousGateTimeoutMs?: number
  autonomousMaxContinuations?: number
  instructions?: string
  rollbackId?: string
  global?: boolean
  name?: string
  scope?: 'current' | 'all'
}

/** The orchestration workflow, rendered into the agent's system prompt. */
const WORKFLOW_SECTION = `## Prime orchestration workflow

For every non-trivial human request, run this loop:

1. ANALYZE before delegating. Read the relevant files (read, grep, glob) until you can state the intent concretely: what must change, where, and how success is verified.
2. GOAL: call create_goal with the elaborated objective — the human's intent restated as one verifiable completion condition.
3. DECOMPOSE the goal into independent, verifiable work packages small enough for one prime-agent session each. When the codebase has several independent parts to change, split the work by part (one worker per subsystem or file area) so workers do not edit the same files.
4. DELEGATE each package with the prime_agent tool (action delegate). Every delegated task must be fully self-contained — prime-agent sessions do NOT see this conversation: include the goal, exact file paths, constraints, and acceptance criteria. Pass a persistent objective with delegate "goal", and bound long-running work with "autonomous" plus its gate/turn/token/timeout flags. Choose the working directory deliberately: prime-agent runs with your user's permissions and is NOT a sandbox, so delegate only into trusted workspaces. Give each worker a distinct scope and tell it which file areas the OTHER workers own, so parallel workers do not collide.
5. MANAGE: poll prime_agent action status/events; discover the fleet with action agents (each row's id is its daemon active session id, the address for messaging/heartbeats); surface a running session's goal lifecycle and idle state with action goal/session; check background-service health with action doctor; steer a running prime-agent session with action send or send_message; stop runaways with action stop. Never wait idle: while delegations run, verify finished work or prepare integration yourself.
6. COORDINATE parallel workers: when several prime agents work on different parts of the code, use action agents to find each worker's id, then action send_message (delivery "steer" to interrupt a busy worker, "follow_up" to queue after its turn) to pass results, warnings, and integration instructions between them. Prime-agent workers can also message each other directly, but the orchestrator owns cross-worker hand-offs and conflict avoidance. Have each worker write results to distinct files and report a short completion summary, then read those files yourself to integrate the parts.
7. HEARTBEATS: for long-running delegated sessions, set a recurring checkpoint with action heartbeat_set ("schedule" like "every 5m"; "message" is the checkpoint prompt; "delivery" steer interrupts, follow_up queues). Heartbeats are per-session and self-updating: read a session's current heartbeat with action heartbeat_get, and when a session reports progress or a new checkpoint in its replies (via events/session), re-issue heartbeat_set with the updated schedule/message to move the checkpoint forward — heartbeat_set replaces the session's existing heartbeat. Pause/resume/stop a heartbeat with action heartbeat_action, and clear a finished session's heartbeat (heartbeat_action "clear") so it stops prompting. A heartbeat set on a subagent session id is a nested heartbeat, managed by the same routes.
8. VERIFY: when a delegation finishes, inspect the actual files or run the checks yourself. For daemon-backed goal sessions, confirm completion with prime_agent action goal/session (look for a COMPLETED compaction and a fresh goalId) — reaching an autonomous limit is a ceiling, not a pass. Only then report or complete the goal; re-delegate with corrections when a result misses its acceptance criteria.

The prime-agent skill documents the CLI, its session JSONL event format, daemon socket control, and pitfalls — load it with the skill tool before non-trivial orchestration. On the harness's web GUI, the Prime fleet column (right side of the window, toggle at the sidebar foot) shows the same delegations, sessions, and service state with live event streams.`

const TOOL_DESCRIPTION = `Delegate, monitor, and manage Prime Agent (prime-agent CLI) sessions. Actions:
- delegate: start a background prime-agent JSON-mode session running "task" in "cwd"; returns a delegation id. The task must be fully self-contained (goal, file paths, constraints, acceptance criteria) — the session does not see this conversation. Optional capability flags: model, provider, thinking, goal, goalTokenBudget, continue, resume, extensions[], skills[], appendSystemPrompt[], offline, and autonomous with autonomousGates[]/autonomousMaxTurns/autonomousMaxTokens/autonomousTimeoutMs/autonomousGateRetries/autonomousGateTimeoutMs/autonomousMaxContinuations.
- agents: structured roster of daemon-managed and saved prime-agent sessions (id = daemon active session id, session id, name, cwd, model, activity, streaming/tools state, rlm depth, parent, heartbeat). Discover which workers are running and address them for coordination; "all": true adds saved (draft) sessions.
- status: prime-agent daemon health plus every delegation started here, with its last event and whether it completed (agent_end seen).
- events: the trailing JSON events of one delegation "id" (optional "limit", default 20, max 100).
- sessions: prime-agent's own persisted sessions (~/.prime/agent/sessions) with size and last-write time.
- send: deliver a message to a running session/agent ("id" = name or session/agent id) via the CLI. Slash commands are NOT parsed. "from" names the sender; "delivery" steer/follow_up controls busy-session delivery.
- send_message: targeted agent-to-agent message over the daemon socket ("target" = agent name or active session id; "from" optional sender; "delivery" steer interrupts a busy session, follow_up queues after the turn); returns a delivery receipt. Use this to coordinate parallel workers.
- agent_messages: control agent-message delivery. "agentMessagesAction" status reads the inbox safety state (paused + queue/rate limits), pause/resume gate all agent messages daemon-wide, clear drops one session's queued agent messages ("agent" = its daemon active session id).
- stop: stop one delegation started here ("id" = delegation id), or a prime-agent session by its session/agent id.
- doctor: prime-agent daemon/supervisor health plus daemon status (background-service verification).
- goal: read-only forensics for a prime-agent session "id" — current thread_goal_state (status/goalId), last goal_context, last slash-command result, last compaction, and idle state, read from ~/.prime/agent/sessions/<id>.jsonl.
- session: like goal but also returns the trailing summarized events (optional "limit", default 30, max 200) of one prime-agent session "id".
- heartbeats: list every heartbeat and scheduled prompt on the daemon (status, source heartbeat/rlm_heartbeat/cron, schedule, delivery mode steer/follow_up, next run, run count, prompt).
- heartbeat_get: read one session's current persistent heartbeat ("agent" = daemon active session id) — its schedule, prompt, delivery mode, and run count — so you can see the current checkpoint before re-setting it.
- heartbeat_set: set a persistent heartbeat on a session ("agent" = daemon active session id; "schedule" like "every 5m" or a cron expression; "message" = the recurring prompt; "delivery" steer interrupts a busy session, follow_up queues after the turn; "source" cron makes a plain scheduled prompt). Re-issuing heartbeat_set on a session REPLACES its existing heartbeat — this is how you self-update a heartbeat to a new checkpoint. Heartbeats are per-session: setting one on a subagent session creates a nested heartbeat.
- heartbeat_action: manage one job — pause/resume/stop by "jobId" + "agent", cancel any job by "jobId", or clear a session's persistent heartbeat by "agent".
- refine: run /refine on a session ("agent" = daemon active session id) to review its trajectory and apply evidence-backed harness updates; optional "instructions", "rollbackId", and "global" flag.
- rename: set a session's name ("agent" + "name").
- compact: compact a session's context now ("agent"; optional "instructions").
- wait_for_idle: block until a session reaches its idle (needs-input) state ("agent"); returns when idle or errors on timeout.
- saved_sessions: list saved (draft) prime-agent sessions via the daemon — "scope" "current" (under cwd) or "all".
- shutdown: stop every agent, worker, and background service ("force": true required to confirm).`

/** Skill catalog description and routing guidance, kept beside the tool wording. */
const SKILL_DESCRIPTION = `Drive the prime-agent CLI (PrimeIntellect's self-improving RLM harness) from this agent: print/JSON/RPC modes, daemon-backed sessions, goals, heartbeats, and agent-to-agent messaging. Prefer the prime_agent tool for delegation, coordination, and heartbeat management; use this skill for daemon control and session forensics.`

const SKILL_WHEN_TO_USE = `When delegating to, steering, coordinating, or inspecting prime-agent sessions beyond what the prime_agent tool covers — daemon socket control, session JSONL parsing, goals, self-updating heartbeats, multi-agent messaging.`

/** Render one canonical JSON value as bounded pretty text for the model. */
function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text.length > 12000 ? `${text.slice(0, 12000)}\n…[truncated]` : text }]
}

/**
 * Register the tool, the workflow section, and the `prime-agent` skill.
 * @param ctx - Cordis context carrying the host services and `ctx.prime`.
 * @param config - resolved config (tool name).
 */
export function apply(ctx: Context, config: Config): void {
  const toolName = config.toolName ?? 'prime_agent'

  ctx.systemPrompt.section({
    name: 'prime-orchestrator:workflow',
    order: WORKFLOW_SECTION_ORDER,
    text: WORKFLOW_SECTION,
  })

  const skillPath = fileURLToPath(new URL('../skills/prime-agent/SKILL.md', import.meta.url))
  const raw = readFileSync(skillPath, 'utf8')
  const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
  ctx.skills.register({
    name: 'prime-agent',
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content,
    path: skillPath,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/prime-agent/', import.meta.url)) },
    source: 'bundled',
  })

  ctx.tools.register(defineTool({
    name: toolName,
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: PRIME_ACTIONS,
        required: true,
        description: 'The operation to perform.',
      },
      task: { type: 'string', description: 'delegate: the self-contained task for the new prime-agent session.' },
      cwd: { type: 'string', description: 'delegate/CLI actions: working directory. Defaults to the session workspace.' },
      id: { type: 'string', description: 'events/stop: delegation id; send/stop/goal/session: prime-agent session or agent id.' },
      message: { type: 'string', description: 'send/send_message/heartbeat_set: the steering or checkpoint message text.' },
      limit: { type: 'integer', description: 'events/session: maximum trailing events to return (events default 20/max 100, session default 30/max 200).' },
      model: { type: 'string', description: 'delegate: prime-agent --model override.' },
      provider: { type: 'string', description: 'delegate: prime-agent --provider override.' },
      thinking: { type: 'string', description: 'delegate: prime-agent --thinking level.' },
      goal: { type: 'string', description: 'delegate: a persistent objective passed as --goal.' },
      goalTokenBudget: { type: 'integer', description: 'delegate: --goal-token-budget (positive int).' },
      continue: { type: 'boolean', description: 'delegate: resume the most recent session (--continue).' },
      resume: { type: 'string', description: 'delegate: resume a specific session by id or path (--resume).' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'delegate: prime-agent --extension values.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'delegate: prime-agent --skill values.' },
      appendSystemPrompt: { type: 'array', items: { type: 'string' }, description: 'delegate: --append-system-prompt values.' },
      offline: { type: 'boolean', description: 'delegate: run with --offline (disables startup network ops).' },
      autonomous: { type: 'boolean', description: 'delegate: enable prime-agent --autonomous mode.' },
      autonomousGates: { type: 'array', items: { type: 'string' }, description: 'delegate: --autonomous-gate values.' },
      autonomousMaxTurns: { type: 'integer', description: 'delegate: --autonomous-max-turns (positive int).' },
      autonomousMaxTokens: { type: 'integer', description: 'delegate: --autonomous-max-tokens (positive int).' },
      autonomousTimeoutMs: { type: 'integer', description: 'delegate: --autonomous-timeout-ms (positive int).' },
      schedule: { type: 'string', description: 'heartbeat_set: schedule expression ("every 5m", "0 9 * * 1-5", "in 30m", "at <ISO date>").' },
      delivery: { type: 'string', enum: ['steer', 'follow_up'], description: 'heartbeat_set/send/send_message: delivery while the session is busy — steer interrupts the turn, follow_up queues after it (default steer).' },
      source: { type: 'string', enum: ['heartbeat', 'cron'], description: 'heartbeat_set: heartbeat (persistent recurring prompt) or cron (plain scheduled prompt) (default heartbeat).' },
      agent: { type: 'string', description: 'heartbeat_get/heartbeat_set/heartbeat_action/agent_messages: daemon active session id of the target session (nested subagent sessions have their own ids).' },
      jobId: { type: 'string', description: 'heartbeat_action: the heartbeat/cron job id from action heartbeats.' },
      heartbeatAction: { type: 'string', enum: ['pause', 'resume', 'stop', 'cancel', 'clear'], description: 'heartbeat_action: the management operation.' },
      target: { type: 'string', description: 'send_message: target agent name, short agent id, or session id.' },
      from: { type: 'string', description: 'send/send_message: identify the sending agent (name or session id).' },
      agentMessagesAction: { type: 'string', enum: ['status', 'pause', 'resume', 'clear'], description: 'agent_messages: the operation — status reads the inbox safety state, pause/resume gate agent messages daemon-wide, clear drops one session\'s queued agent messages.' },
      all: { type: 'boolean', description: 'agents: include saved (draft) sessions in the roster.' },
      force: { type: 'boolean', description: 'shutdown: confirm stopping every agent, worker, and background service (must be true).' },
      autonomousGateRetries: { type: 'integer', description: 'delegate: --autonomous-gate-retries (positive int).' },
      autonomousGateTimeoutMs: { type: 'integer', description: 'delegate: --autonomous-gate-timeout-ms (positive int).' },
      autonomousMaxContinuations: { type: 'integer', description: 'delegate: --autonomous-max-continuations (positive int).' },
      instructions: { type: 'string', description: 'refine/compact: optional instructions for the harness refinement or compaction.' },
      rollbackId: { type: 'string', description: 'refine: optional refinement id to roll back to.' },
      global: { type: 'boolean', description: 'refine: apply the refinement globally (defaults to session-local).' },
      name: { type: 'string', description: 'rename: the new session name.' },
      scope: { type: 'string', enum: ['current', 'all'], description: 'saved_sessions: "current" lists saved sessions under cwd, "all" lists every saved session (default current).' },
    },
    output: {
      schema: { type: 'json' },
      render: renderJson,
    },
    async execute(args, exec) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('prime_agent: arguments must be an object')
      }
      const a = args as PrimeAgentArgs
      switch (a.action) {
        case 'delegate': {
          if (typeof a.task !== 'string' || a.task.trim().length === 0) {
            throw new Error('prime_agent delegate: "task" is required and must be a non-empty string')
          }
          const delegation = await ctx.prime.delegate(a as unknown as PrimeDelegateRequest)
          return {
            action: 'delegate',
            ok: delegation.status === 'running',
            delegation,
            hint: delegation.status === 'running'
              ? 'The session runs in the background. Poll with action status/events; the web GUI shows the same state in the Prime fleet column.'
              : 'The session failed to start.',
          } as unknown as JsonValue
        }
        case 'stop': {
          if (typeof a.id !== 'string' || a.id.length === 0) {
            throw new Error('prime_agent stop: "id" is required')
          }
          return (await ctx.prime.stop(a.id, exec.signal)) as unknown as JsonValue
        }
        default: {
          return (await ctx.prime.execute(a.action, a as unknown as Record<string, unknown>, exec.signal)) as unknown as JsonValue
        }
      }
    },
  }))
}