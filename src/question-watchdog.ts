/**
 * Question watchdog — the "never again" safety net for `ask_user_question`.
 *
 * Root cause this closes (verified 2026-09-04): the web composer takeover is
 * delivered over the browser's live `events.mux` WebSocket, and that stream
 * has no app-level liveness probe — a silently dead socket (sleep/wake,
 * tunnel drop) never re-delivers, the pending question waits forever, and the
 * agent turn freezes (queued messages wait, compaction is refused). The dsh
 * core replays pending questions only to NEW connections, so the plugin adds
 * two recovery layers around that seam:
 *
 * 1. A host-side watchdog (this module, started by the engine whenever a web
 *    server exists) connects to the local mux as an ordinary client — the
 *    same frames a browser gets — and tracks every pending question. After a
 *    configurable timeout it auto-answers (recommended option / first option
 *    / cancel) through the same `/api/respond` route the composer uses.
 * 2. A browser banner (client/questions/) polls `/prime/api/questions` over
 *    plain HTTP — immune to a dead event stream — and can answer or cancel
 *    any pending question inline.
 *
 * No provider is registered (the api-proxy owns `ctx.userQuestions` and
 * duplicates are rejected); the watchdog only observes and responds, exactly
 * like a second browser tab would. The dependency-free transport is Node's
 * global WebSocket + global fetch (Node >= 22).
 *
 * @module dsh-prime-orchestrator/question-watchdog
 */

import { spawn } from 'node:child_process'

/** Auto-answer strategies. */
export type QuestionWatchdogStrategy = 'recommended' | 'first' | 'cancel'

/** One option of a pending question (wire shape, passed through verbatim). */
export interface WatchdogQuestionOption {
  label: string
  description?: string
}

/** One question of a pending batch (wire shape, passed through verbatim). */
export interface WatchdogQuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: WatchdogQuestionOption[]
  multiSelect?: boolean
}

/** One answer item of a question batch (core `AskUserQuestionAnswerItem`). */
export interface WatchdogAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** Live-resolved watchdog configuration (projected by the engine's toConfig). */
export interface QuestionWatchdogConfig {
  enabled: boolean
  timeoutMs: number
  strategy: QuestionWatchdogStrategy
  notifyEnabled: boolean
}

/** Public view of one pending question (served by /prime/api/questions). */
export interface PendingQuestionView {
  rpcId: string
  sessionId: string
  questions: WatchdogQuestionItem[]
  askedAt: number
  /** Epoch ms when the armed timer fires, or null when auto-answer is off. */
  autoAt: number | null
}

/** Public view of one watchdog action (served by /prime/api/questions). */
export interface QuestionActionRecord {
  at: number
  rpcId: string
  sessionId: string
  action: 'auto-answer' | 'auto-cancel' | 'manual-answer' | 'manual-cancel' | 'respond-error' | 'skipped-disabled'
  strategy: QuestionWatchdogStrategy | 'user' | 'off'
  detail: string
}

/** Strategies accepted by settings validation. */
export const QUESTION_WATCHDOG_STRATEGIES: readonly QuestionWatchdogStrategy[] = ['recommended', 'first', 'cancel']

/** Default auto-answer timeout (unset/0 settings fold to this). */
export const DEFAULT_QUESTION_WATCHDOG_TIMEOUT_MS = 15 * 60_000

/** The conventional recommendation suffix the stock client renders as a badge. */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

/** Mux-keepalive bound for the recent-actions ring. */
const RECENT_LIMIT = 20

/**
 * Pick the option label a strategy would answer with.
 * @param question - the question to answer.
 * @param strategy - the auto-answer strategy.
 * @returns the option label, or null when no option can be picked.
 */
export function pickOptionLabel(question: WatchdogQuestionItem, strategy: QuestionWatchdogStrategy): string | null {
  if (strategy === 'cancel') return null
  const options = question.options ?? []
  if (options.length === 0) return null
  if (strategy === 'first') return options[0].label
  const recommended = options.find(option => RECOMMENDED_SUFFIX.test(option.label))
  return (recommended ?? options[0]).label
}

/**
 * Build the whole answer batch for a strategy, or a cancel when any question
 * cannot be meaningfully auto-picked (no options on a choice question —
 * fabricating free text would inject garbage into the agent's reasoning, so
 * the batch is cancelled instead and the tool reports the user cancelled).
 * @param questions - the full pending batch.
 * @param strategy - the auto-answer strategy.
 * @returns an answers batch, or a cancel with the reason.
 */
export function buildAutoAnswer(
  questions: WatchdogQuestionItem[],
  strategy: QuestionWatchdogStrategy,
): { answers: WatchdogAnswerItem[] } | { cancel: true; reason: string } {
  if (strategy === 'cancel') return { cancel: true, reason: 'strategy is cancel' }
  const answers: WatchdogAnswerItem[] = []
  for (const question of questions) {
    const label = pickOptionLabel(question, strategy)
    if (label === null) return { cancel: true, reason: `question "${question.id}" has no options to auto-pick` }
    answers.push({ id: question.id, selected: [label] })
  }
  return { answers }
}

/** One tracked pending question with its armed timer. */
interface PendingEntry {
  rpcId: string
  sessionId: string
  questions: WatchdogQuestionItem[]
  askedAt: number
  autoAt: number | null
  timer: NodeJS.Timeout | null
}

/** Constructor options. */
export interface QuestionWatchdogOptions {
  /** Bind host of the local web server (loopback literal resolved by the engine). */
  host: string
  /** Listening port of the local web server. */
  port: number
  /** Live config getter (read at request and fire time). */
  getConfig: () => QuestionWatchdogConfig
  /** Optional diagnostic sink. */
  log?: (message: string) => void
}

/**
 * The mux-client watchdog. One instance per web server mount; see the module
 * doc for the design. All failures are logged and retried — a watchdog
 * outage must never take the web server down.
 */
export class QuestionWatchdog {
  private readonly opts: QuestionWatchdogOptions
  private ws: WebSocket | null = null
  private readonly pending = new Map<string, PendingEntry>()
  private readonly recent: QuestionActionRecord[] = []
  private stopped = false
  private retryDelayMs = 1_000
  private retryTimer: NodeJS.Timeout | null = null
  private notifiedRpcIds = new Set<string>()

  constructor(options: QuestionWatchdogOptions) {
    this.opts = options
  }

  /** Start observing. No-op (logged) when the runtime lacks a global WebSocket. */
  start(): void {
    if (typeof WebSocket === 'undefined') {
      this.opts.log?.('[prime-orchestrator] question watchdog: no global WebSocket — disabled')
      return
    }
    this.connect()
  }

  /** Stop observing, clear timers, and drop the socket. */
  stop(): void {
    this.stopped = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const entry of this.pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = null
    }
    try { this.ws?.close() } catch { /* already gone */ }
    this.ws = null
  }

  /** Current public state for /prime/api/questions. */
  state(): { active: boolean; config: QuestionWatchdogConfig; pending: PendingQuestionView[]; recent: QuestionActionRecord[] } {
    const config = this.opts.getConfig()
    return {
      active: !this.stopped,
      config,
      pending: [...this.pending.values()].map(entry => ({
        rpcId: entry.rpcId,
        sessionId: entry.sessionId,
        questions: entry.questions,
        askedAt: entry.askedAt,
        autoAt: entry.autoAt,
      })),
      recent: [...this.recent].reverse(),
    }
  }

  /**
   * Answer or cancel one tracked pending question through /api/respond —
   * the same wire the browser composer uses. Serves both the auto-answer
   * timer and the manual /prime/api/questions/respond relay.
   * @param rpcId - the pending question's frame rpcId.
   * @param action - an answers batch, or a cancel.
   * @param cause - who is responding (for the recent log).
   */
  async respond(
    rpcId: string,
    action: { answers: WatchdogAnswerItem[] } | { cancel: true },
    cause: 'auto' | 'user',
  ): Promise<{ accepted: boolean; reason?: string }> {
    const entry = this.pending.get(rpcId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    const cancelling = 'cancel' in action
    const result = cancelling
      ? {
        ok: false as const,
        error: { code: 'cancelled', message: cause === 'auto' ? 'auto-cancelled by the prime-orchestrator question watchdog' : 'the user closed this question request', details: {} },
      }
      : { ok: true as const, value: { sessionId: entry.sessionId, answer: { answers: action.answers } } }
    try {
      const res = await fetch(`http://${this.opts.host}:${this.opts.port}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result }),
      })
      const body = await res.json().catch(() => ({ accepted: false, reason: `HTTP ${res.status}` })) as { accepted?: boolean; reason?: string }
      const accepted = body.accepted === true
      this.record({
        at: Date.now(),
        rpcId,
        sessionId: entry.sessionId,
        action: accepted ? (cancelling ? (cause === 'auto' ? 'auto-cancel' : 'manual-cancel') : cause === 'auto' ? 'auto-answer' : 'manual-answer') : 'respond-error',
        strategy: cause === 'auto' ? this.opts.getConfig().strategy : 'user',
        detail: accepted
          ? cancelling
            ? 'cancelled'
            : `answered: ${action.answers.map(a => `${a.id}=${a.selected.join('|')}${a.custom ?? ''}`).join('; ')}`
          : `rejected: ${body.reason ?? 'unknown'}`,
      })
      if (accepted) this.settle(rpcId)
      return { accepted, reason: body.reason }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.record({
        at: Date.now(), rpcId, sessionId: entry.sessionId, action: 'respond-error',
        strategy: cause === 'auto' ? this.opts.getConfig().strategy : 'user', detail: message,
      })
      return { accepted: false, reason: message }
    }
  }

  /** Drop a settled entry (the resolved frame also lands here; idempotent). */
  private settle(rpcId: string): void {
    const entry = this.pending.get(rpcId)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    this.pending.delete(rpcId)
  }

  /** Append to the bounded recent ring. */
  private record(record: QuestionActionRecord): void {
    this.recent.push(record)
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT)
  }

  /** Open (or reopen) the mux observation socket. */
  private connect(): void {
    if (this.stopped) return
    const url = `ws://${this.opts.host}:${this.opts.port}/api/events.mux`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.opts.log?.(`[prime-orchestrator] question watchdog: connect failed (${error instanceof Error ? error.message : String(error)}) — retrying`)
      this.scheduleRetry()
      return
    }
    this.ws = socket
    socket.onopen = () => {
      this.retryDelayMs = 1_000
      this.opts.log?.('[prime-orchestrator] question watchdog: mux connected')
    }
    socket.onmessage = (event: MessageEvent) => {
      this.onFrame(String(event.data))
    }
    socket.onclose = () => {
      this.ws = null
      this.scheduleRetry()
    }
    socket.onerror = () => {
      /* onclose follows; nothing to do here */
    }
  }

  /** Reconnect with bounded exponential backoff (1s → 10s). */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, this.retryDelayMs)
    this.retryTimer.unref?.()
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 10_000)
  }

  /** Handle one mux frame text. */
  private onFrame(text: string): void {
    if (!text.includes('question/')) return
    let frame: { rpcId?: unknown; method?: unknown; payload?: { type?: unknown; sessionId?: unknown; questions?: unknown; questionRpcId?: unknown } }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const payload = frame.payload
    if (payload?.type === 'question/requested') {
      const rpcId = typeof frame.rpcId === 'string' ? frame.rpcId : ''
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (rpcId === '' || sessionId === '' || !Array.isArray(payload.questions)) return
      this.onRequested(rpcId, sessionId, payload.questions as WatchdogQuestionItem[])
    } else if (payload?.type === 'question/resolved') {
      const rpcId = typeof payload.questionRpcId === 'string' ? payload.questionRpcId : ''
      if (rpcId !== '') this.settle(rpcId)
    }
  }

  /** Track one pending question, notify, and arm its timer. */
  private onRequested(rpcId: string, sessionId: string, questions: WatchdogQuestionItem[]): void {
    if (this.pending.has(rpcId)) return // replay after reconnect: the armed timer already lives
    const config = this.opts.getConfig()
    const autoAt = config.enabled && config.timeoutMs > 0 ? Date.now() + config.timeoutMs : null
    const entry: PendingEntry = { rpcId, sessionId, questions, askedAt: Date.now(), autoAt, timer: null }
    this.pending.set(rpcId, entry)
    if (autoAt !== null) {
      entry.timer = setTimeout(() => { void this.fire(entry) }, config.timeoutMs)
      entry.timer.unref?.()
    }
    if (config.notifyEnabled && !this.notifiedRpcIds.has(rpcId)) {
      this.notifiedRpcIds.add(rpcId)
      if (this.notifiedRpcIds.size > 200) this.notifiedRpcIds.clear() // bounded, never precise-critical
      const first = questions[0]
      const label = first?.header ?? (first?.question ?? '').slice(0, 80)
      notifyMac(
        'DSH — question waiting for you',
        autoAt === null
          ? `${label} (session ${sessionId.slice(8, 20)}…)`
          : `${label} — auto-${config.strategy} in ${Math.round(config.timeoutMs / 60_000)} min`,
      )
    }
    this.opts.log?.(`[prime-orchestrator] question watchdog: pending ${questions.map(q => q.id).join(',')} in ${sessionId}`)
  }

  /** Timer fire: re-read config, auto-answer or auto-cancel, notify. */
  private async fire(entry: PendingEntry): Promise<void> {
    if (!this.pending.has(entry.rpcId)) return
    entry.timer = null
    const config = this.opts.getConfig()
    if (!config.enabled) {
      this.record({ at: Date.now(), rpcId: entry.rpcId, sessionId: entry.sessionId, action: 'skipped-disabled', strategy: 'off', detail: 'watchdog disabled while waiting' })
      this.settle(entry.rpcId)
      return
    }
    const outcome = buildAutoAnswer(entry.questions, config.strategy)
    const result = await this.respond(
      entry.rpcId,
      'cancel' in outcome ? { cancel: true } : { answers: outcome.answers },
      'auto',
    )
    if (result.accepted && config.notifyEnabled) {
      const summary = 'cancel' in outcome
        ? 'cancelled (no auto-pickable options)'
        : `answered "${outcome.answers.map(a => a.selected.join(', ')).join('; ')}"`
      notifyMac('DSH — question auto-answered', `Watchdog ${summary} in session ${entry.sessionId.slice(8, 20)}…`)
    }
  }
}

/** Fire one best-effort macOS notification (other platforms: no-op). */
function notifyMac(title: string, body: string): void {
  if (process.platform !== 'darwin') return
  try {
    const esc = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200)
    const child = spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
  } catch {
    /* notifications are best effort */
  }
}
