/**
 * The fleet feed store: the shared roster snapshot both entries read (the
 * panel renders it; the sidebar toggle derives its badge). Declared at the
 * panel/toggle registrations from one handle minted in apply; the panel's
 * polling effect is the sole writer. Pure helpers beside it (relative time,
 * state mapping, flag-list parsing) are the testable projections.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { PrimeAgent, PrimeDelegation, PrimeState } from './api.ts'

/** Feed state: the last successful snapshot, or the error that replaced it. */
export interface PrimeFeedState {
  feed: PrimeState | undefined
  error: string | undefined
}

/** Mutation set: replace the snapshot, or record/replace the feed error. */
type PrimeFeedActions = {
  setFeed: (draft: PrimeFeedState, feed: PrimeState) => void
  setError: (draft: PrimeFeedState, message: string) => void
}

/**
 * Create the fleet feed store handle (unpersisted, root-scope).
 * @returns the store handle for the registration's store seat.
 */
export function createPrimeStore(): EngineStoreHandle<PrimeFeedState, PrimeFeedActions> {
  return defineStore({
    init: (): PrimeFeedState => ({ feed: undefined, error: undefined }),
    actions: {
      setFeed: (d, feed) => {
        d.feed = feed
        d.error = undefined
      },
      setError: (d, message) => {
        d.error = message
      },
    },
  })
}

/**
 * Count of live delegations for the toggle badge.
 * @param feed - the last roster snapshot, or undefined before the first poll.
 * @returns the number of running delegations.
 */
export function runningCount(feed: PrimeState | undefined): number {
  return feed?.delegations.filter(d => d.status === 'running').length ?? 0
}

/**
 * Map a delegation status onto the four-color StateDot semantic.
 * @param status - the delegation lifecycle status.
 * @returns the StateDot state it presents as.
 */
export function dotStateOf(status: PrimeDelegation['status']): 'ongoing' | 'done' | 'error' | 'warning' {
  switch (status) {
    case 'running': return 'ongoing'
    case 'exited': return 'done'
    case 'failed': return 'error'
    case 'stopped': return 'warning'
  }
}

/** Agent activity buckets: the terminal's running / idle / inactive sections. */
export type AgentActivity = 'active' | 'idle' | 'draft'

/**
 * Classify one projected agent into the roster's three sections.
 * Draft (saved, zero-message) sessions are inactive; a live session is
 * active when any work flag is set and idle otherwise.
 * @param agent - the preset's projected agent view.
 * @returns the activity bucket.
 */
export function agentActivityOf(agent: PrimeAgent): AgentActivity {
  if (agent.lifecycle === 'draft') return 'draft'
  if (
    agent.isSessionActive
    || agent.isStreaming
    || agent.isCompacting
    || agent.isRunningTools
    || agent.isBashRunning
    || agent.activity === 'working'
  ) return 'active'
  return 'idle'
}

/**
 * Resolve the session-inspection id for an agent: the on-disk session file
 * basename when present (authoritative for `/prime/api/session`), else the
 * daemon session id, else the agent id.
 * @param agent - the preset's projected agent view.
 * @returns the id to pass to `api.session`.
 */
export function agentSessionId(agent: PrimeAgent): string {
  const file = agent.sessionFile
  if (file !== null && file.length > 0) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    if (base.length > 0) return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
  }
  return agent.sessionId ?? agent.id ?? ''
}

/** Sectioned roster: agents grouped by activity, order preserved within each. */
export interface PrimeAgentSections {
  active: PrimeAgent[]
  idle: PrimeAgent[]
  draft: PrimeAgent[]
}

/**
 * Group a roster into the three activity sections.
 * @param agents - the projected agent views in list order.
 * @returns the three buckets.
 */
export function sectionAgents(agents: readonly PrimeAgent[]): PrimeAgentSections {
  const sections: PrimeAgentSections = { active: [], idle: [], draft: [] }
  for (const agent of agents) sections[agentActivityOf(agent)].push(agent)
  return sections
}

/**
 * Last non-empty path segment of an absolute path, for compact cwd display.
 * A root path (`/`) has no segments and is returned unchanged.
 * @param path - the absolute path.
 * @returns the trailing segment.
 */
export function baseNameOf(path: string): string {
  const segments = path.split('/').filter(Boolean)
  const last = segments.at(-1)
  return last === undefined ? path : last
}

/**
 * Compact relative time for started/ended stamps and session mtimes.
 * @param iso - the timestamp to age.
 * @param now - the current epoch ms.
 * @returns age descriptor for the locale's time.* keys.
 */
export function ageOf(iso: string, now: number): { unit: 'now' | 'minute' | 'hour' | 'day'; n: number } {
  const ms = Math.max(0, now - Date.parse(iso))
  if (Number.isNaN(ms)) return { unit: 'now', n: 0 }
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return { unit: 'now', n: 0 }
  if (minutes < 60) return { unit: 'minute', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hour', n: hours }
  return { unit: 'day', n: Math.floor(hours / 24) }
}

/**
 * Compact future-time descriptor for the next heartbeat run.
 * @param iso - the upcoming timestamp.
 * @param now - the current epoch ms.
 * @returns future descriptor for the locale's time.in.* keys; past or
 * unparsable stamps collapse to "soon".
 */
export function untilOf(iso: string, now: number): { unit: 'soon' | 'minute' | 'hour' | 'day'; n: number } {
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms) || ms <= 0) return { unit: 'soon', n: 0 }
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return { unit: 'soon', n: 0 }
  if (minutes < 60) return { unit: 'minute', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hour', n: hours }
  return { unit: 'day', n: Math.floor(hours / 24) }
}

/**
 * Parse a comma-separated flag list ("gates, checks") into clean strings;
 * blank entries drop. Used by the delegate form's list-valued fields.
 * @param raw - the raw input text.
 * @returns the non-empty trimmed values, or undefined when none.
 */
export function parseFlagList(raw: string): string[] | undefined {
  const values = raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
  return values.length > 0 ? values : undefined
}

/**
 * Parse a positive-integer form field.
 * @param raw - the raw input text.
 * @returns the integer, or undefined when blank/invalid.
 */
export function parsePositiveInt(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}
