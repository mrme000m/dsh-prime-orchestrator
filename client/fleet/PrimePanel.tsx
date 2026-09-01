// PrimePanel: the fleet column occupant. Header + fleet pulse over the
// shared feed store, three tabs (fleet / sessions / services), a drill-in
// agent detail, and the pinned delegate form. The polling effect is the
// feed store's sole writer: open column 3s, collapsed 10s (the toggle badge
// stays fresh), paused while the tab is hidden. Presentation only — data
// arrives through the store seat, actions through the inject face, copy
// through the locale seat.

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Button, Pill, RiskConfirmation, StateDot, TerminalBlock, Tooltip,
  IconAgentPresetOutline16, IconCloseOutline16, IconRefreshOutline16, IconSendOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrimeAgent, PrimeAgentMessagesStatus, PrimeApi, PrimeDelegateInput, PrimeDelegation, PrimeEventSummary, PrimeHeartbeat, PrimeSessionInspection } from './api.ts'
import type { createPrimeStore } from './store.ts'
import { ageOf, agentActivityOf, agentSessionId, baseNameOf, dotStateOf, runningCount, sectionAgents, type AgentActivity } from './store.ts'
import { DelegateForm } from './DelegateForm.tsx'
import { AgentDetail } from './AgentDetail.tsx'
import { Heartbeats } from './Heartbeats.tsx'
import css from './PrimePanel.module.css'

/** Injected share: the API face plus the layout close transition. */
export interface PrimePanelInjected {
  /** Typed same-origin client over the preset's /prime routes. */
  api: PrimeApi
  /** Close the fleet column through ctx.layout. */
  close: () => void
}

/** Full panel props: runtime share (column state) + store seat + inject face + locale seat. */
export type PrimePanelProps =
  & PropsRuntime<'prime'>
  & PropsStore<ReturnType<typeof createPrimeStore>>
  & PrimePanelInjected
  & PropsLocale<'prime'>

/** Panel tab keys. */
type Tab = 'fleet' | 'sessions' | 'services' | 'heartbeats'

/** The drill-in target: a harness delegation or any prime-agent session file. */
export type Selection =
  | { kind: 'delegation'; id: string }
  | { kind: 'session'; id: string }

/** One fleet roster card. Click opens the detail; actions stop propagation. */
function DelegationCard(props: {
  delegation: PrimeDelegation
  t: PrimePanelProps['t']
  now: number
  onOpen: () => void
  onStop: () => void
}) {
  const { delegation: d, t } = props
  return (
    <article
      className={css.card}
      data-status={d.status}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={t('delegation.action.aria', { id: d.id })}
    >
      <div className={css.cardHead}>
        <StateDot state={dotStateOf(d.status)} />
        <span className={css.cardId}>{`#${d.id}`}</span>
        <span className={clsx(css.cardState, css[`state-${d.status}`])}>{t(`status.${d.status}.label`)}</span>
        <span className={css.cardAge}>{props.t(`time.${ageOf(d.startedAt, props.now).unit}`,
          { n: ageOf(d.startedAt, props.now).n })}</span>
      </div>
      <p className={css.cardTask}>{d.task}</p>
      {d.lastText !== null && <p className={css.cardLast}>{d.lastText}</p>}
      <div className={css.cardMeta}>
        {d.lastEventType !== null && t('delegation.lastEvent', { type: d.lastEventType })}
        {d.completed && ` · ${t('delegation.completed')}`}
        {d.exitCode !== null && d.exitCode !== 0 && ` · ${t('delegation.exitCode', { code: d.exitCode })}`}
      </div>
      {d.error !== null && <p className={clsx(css.cardMeta, css.cardError)}>{t('delegation.error', { message: d.error })}</p>}
      <div
        className={css.cardActions}
        onClick={(event) => { event.stopPropagation() }}
        onKeyDown={(event) => { event.stopPropagation() }}
      >
        {d.status === 'running' && (
          <Button size="sm" icon={<IconStopFill16 size={14} />} onClick={props.onStop}>{t('delegation.stop')}</Button>
        )}
      </div>
    </article>
  )
}

/** Agent activity bucket → the four-color StateDot semantic. */
const AGENT_DOT: Record<AgentActivity, 'ongoing' | 'done' | 'error' | 'warning'> = {
  active: 'ongoing',
  idle: 'done',
  draft: 'warning',
}

/** One daemon agent row: activity dot, task/name, model + thinking + message facts. */
function AgentRow(props: {
  agent: PrimeAgent
  t: PrimePanelProps['t']
  onOpen: () => void
}) {
  const { agent: a, t } = props
  const activity = agentActivityOf(a)
  const model = a.model ?? a.modelId
  const cwd = a.cwd !== null ? baseNameOf(a.cwd) : undefined
  const facts: string[] = []
  if (model !== null) facts.push(model)
  if (a.thinking !== null) facts.push(a.thinking)
  facts.push(t('agents.messages', { n: a.messageCount }))
  if (cwd !== undefined) facts.push(cwd)
  const chips: string[] = []
  if (a.isStreaming) chips.push(t('agents.chip.streaming'))
  if (a.isCompacting) chips.push(t('agents.chip.compacting'))
  if (a.isRunningTools) chips.push(t('agents.chip.tools'))
  if (a.isBashRunning) chips.push(t('agents.chip.bash'))
  if (a.taskState === 'needs_input') chips.push(t('agents.chip.needsInput'))
  if (a.hasActiveHeartbeat) chips.push(t('agents.chip.heartbeat'))
  if (a.hasRegisteredCronJob && !a.hasActiveHeartbeat) chips.push(t('agents.chip.scheduled'))
  return (
    <button
      type="button"
      className={css.agentRow}
      data-activity={activity}
      onClick={props.onOpen}
      aria-label={t('agents.aria', { id: a.id ?? a.sessionId ?? '' })}
    >
      <StateDot state={AGENT_DOT[activity]} className={css.agentDot} />
      <span className={css.agentBody}>
        <span className={css.agentName}>{a.firstMessage ?? (a.id ?? '').slice(0, 8)}</span>
        <span className={css.agentMeta}>{facts.join(' · ')}</span>
      </span>
      {chips.length > 0 && <span className={css.agentChips}>{chips.join(' · ')}</span>}
    </button>
  )
}

/** The daemon roster: running/idle/inactive sections of agent rows. */
function RosterSection(props: {
  agents: readonly PrimeAgent[]
  t: PrimePanelProps['t']
  onOpen: (id: string) => void
}) {
  const { agents, t } = props
  const sections = sectionAgents(agents)
  const groups: { key: AgentActivity; label: string; rows: PrimeAgent[] }[] = [
    { key: 'active', label: t('agents.section.active'), rows: sections.active },
    { key: 'idle', label: t('agents.section.idle'), rows: sections.idle },
    { key: 'draft', label: t('agents.section.draft'), rows: sections.draft },
  ]
  return (
    <section className={css.roster}>
      {agents.length === 0 && <div className={css.empty}>{t('agents.empty')}</div>}
      {groups.map(group => group.rows.length > 0 && (
        <div key={group.key} className={css.rosterGroup}>
          <div className={css.rosterLabel}>{`${group.label} · ${group.rows.length}`}</div>
          {group.rows.map(agent => (
            <AgentRow
              key={agent.sessionId ?? agent.id ?? ''}
              agent={agent}
              t={t}
              onOpen={() => { props.onOpen(agentSessionId(agent)) }}
            />
          ))}
        </div>
      ))}
    </section>
  )
}

/**
 * Render the Prime fleet column.
 * @param props - composed slot props (column state, feed store, api/close inject, locale).
 * @returns the panel element tree.
 */
export function PrimePanel({ collapsed, useStore, actions, api, close, t }: PrimePanelProps) {
  const feed = useStore(s => s.feed)
  const feedError = useStore(s => s.error)
  const [tab, setTab] = useState<Tab>('fleet')
  const [selection, setSelection] = useState<Selection | undefined>(undefined)
  const [manualRefresh, setManualRefresh] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [detailEvents, setDetailEvents] = useState<readonly PrimeEventSummary[] | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [sessionDetail, setSessionDetail] = useState<PrimeSessionInspection | undefined>(undefined)
  const [stopTarget, setStopTarget] = useState<PrimeDelegation | undefined>(undefined)
  const [stopAck, setStopAck] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [agents, setAgents] = useState<readonly PrimeAgent[] | undefined>(undefined)
  const [agentsError, setAgentsError] = useState<string | undefined>(undefined)
  const [heartbeatJobs, setHeartbeatJobs] = useState<readonly PrimeHeartbeat[] | undefined>(undefined)
  const [heartbeatError, setHeartbeatError] = useState<string | undefined>(undefined)

  // The feed's sole writer: an immediate run plus the cadence interval. The
  // selected delegation's event tail rides the same tick (a cheap bounded
  // file read); a session inspection re-fetches on selection change or a
  // manual refresh only (whole-file reads can be 15MB+).
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const next = await api.state()
        if (cancelled) return
        actions.setFeed(next)
        setNow(Date.now())
        if (selection?.kind === 'delegation') {
          const events = await api.events(selection.id)
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the flag flips in the effect cleanup.
          if (cancelled) return
          setDetailEvents(events)
        }
      } catch (error) {
        if (cancelled) return
        actions.setError(error instanceof Error ? error.message : String(error))
      }
      // v8 ignore next -- the cancelled early-returns above make the false path unreachable here.
      if (!cancelled) setRefreshing(false) // oxlint-disable-line typescript/no-unnecessary-condition -- flips in the cleanup.
    }
    void run()
    const timer = window.setInterval(() => { void run() }, collapsed ? 10_000 : 3_000)
    const onVisible = (): void => { if (!document.hidden) void run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, actions, collapsed, selection, manualRefresh])

  // Session drill-ins load once per selection (heavy whole-file read).
  useEffect(() => {
    if (selection?.kind !== 'session') return
    let cancelled = false
    setDetailEvents(undefined)
    setDetailError(undefined)
    setSessionDetail(undefined)
    void api.session(selection.id).then(
      (inspection) => {
        if (cancelled) return
        setSessionDetail(inspection)
        setDetailEvents(inspection.events)
      },
      (error: unknown) => {
        if (cancelled) return
        setDetailError(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [api, selection, manualRefresh])

  // The daemon roster refreshes on a slower cadence than the delegation feed
  // (it shells out to `prime-agent list --json`) plus on manual refresh.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const roster = await api.agents(true)
        if (cancelled) return
        setAgents(roster.agents)
        setAgentsError(undefined)
      } catch (error) {
        if (cancelled) return
        setAgentsError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 10_000)
    const onVisible = (): void => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, manualRefresh])

  // The heartbeat catalog fetches while its tab is open (30s cadence) plus
  // after every mutation (manualRefresh) — daemon socket reads, kept lazy.
  useEffect(() => {
    if (tab !== 'heartbeats') return
    let cancelled = false
    const load = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const catalog = await api.heartbeats()
        if (cancelled) return
        setHeartbeatJobs(catalog.jobs)
        setHeartbeatError(undefined)
      } catch (error) {
        if (cancelled) return
        setHeartbeatError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 30_000)
    const onVisible = (): void => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, tab, manualRefresh])

  const selectedDelegation = useMemo(() => {
    if (selection?.kind !== 'delegation') return undefined
    return feed?.delegations.find(d => d.id === selection.id)
  }, [feed, selection])

  // The roster row matching a session drill-in (its daemon active id drives
  // the detail's heartbeat_get and send_message targets).
  const selectedAgent = useMemo(() => {
    if (selection?.kind !== 'session') return undefined
    return agents?.find(a => agentSessionId(a) === selection.id)
  }, [agents, selection])

  const counts = useMemo(() => ({
    running: runningCount(feed),
    ended: feed === undefined ? 0 : feed.delegations.length - runningCount(feed),
  }), [feed])

  const refresh = (): void => {
    setRefreshing(true)
    setManualRefresh(n => n + 1)
  }

  const afterAction = (): void => {
    setRefreshing(true)
    setManualRefresh(n => n + 1)
  }

  const openSelection = (next: Selection): void => {
    setSelection(next)
    setDetailEvents(undefined)
    setDetailError(undefined)
  }

  const delegate = async (input: PrimeDelegateInput): Promise<void> => {
    const started = await api.delegate(input)
    setNotice(t('delegate.started', { id: started.id }))
    afterAction()
  }

  const stopConfirmed = async (): Promise<void> => {
    /* v8 ignore next -- UI armor: the confirmation only renders with a stop target set. */
    if (stopTarget === undefined) return
    try {
      const result = await api.stop(stopTarget.id)
      if (!result.ok) throw new Error(result.output ?? 'stop failed')
    } catch (error) {
      setActionError(t('stop.failed', { message: error instanceof Error ? error.message : String(error) }))
    }
    setStopTarget(undefined)
    setStopAck(false)
    afterAction()
  }

  return (
    <div className={css.root} data-collapsed={collapsed || undefined}>
      <header className={css.header}>
        <div className={css.titleRow}>
          <h2 className={css.title}>
            <IconAgentPresetOutline16 size={16} className={css.titleIcon} aria-hidden />
            {t('title')}
          </h2>
          <div className={css.headerActions}>
            <Tooltip label={refreshing ? t('refreshing') : t('refresh')} side="bottom">
              <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={refresh}>
                <IconRefreshOutline16 size={16} className={clsx(refreshing && css.spinning)} />
              </button>
            </Tooltip>
            <Tooltip label={t('panel.close')} side="bottom">
              <button type="button" className={css.iconButton} aria-label={t('panel.close')} onClick={close}>
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className={clsx(css.statusLine, feedError !== undefined && css.statusError)}>
          {feedError !== undefined
            ? (
              <>
                {t('feed.error', { message: feedError })}
                <button type="button" className={css.retry} onClick={refresh}>{t('feed.retry')}</button>
              </>
            )
            : feed === undefined
              ? t('refreshing')
              : (
                <>
                  <span className={css.count}><StateDot state="ongoing" /> {t('status.running', { n: counts.running })}</span>
                  <span className={css.count}>{t('status.ended', { n: counts.ended })}</span>
                  <span className={css.count}>{t('status.sessions', { n: feed.sessions.length })}</span>
                </>
              )}
        </div>
      </header>

      {selection !== undefined
        ? (
          <AgentDetail
            selection={selection}
            delegation={selectedDelegation}
            inspection={sessionDetail}
            events={detailEvents}
            error={detailError}
            agent={selectedAgent}
            api={api}
            t={t}
            onBack={() => { setSelection(undefined) }}
            onStop={() => { setStopTarget(selectedDelegation); setStopAck(false) }}
            onChanged={afterAction}
          />
        )
        : (
          <>
            {actionError !== undefined && <p className={css.globalError}>{actionError}</p>}
            <nav className={css.tabs} aria-label={t('title')}>
              <Pill active={tab === 'fleet'} onClick={() => { setTab('fleet') }}>{t('tab.fleet')}</Pill>
              <Pill active={tab === 'sessions'} onClick={() => { setTab('sessions') }}>{t('tab.sessions')}</Pill>
              <Pill active={tab === 'heartbeats'} onClick={() => { setTab('heartbeats') }}>{t('tab.heartbeats')}</Pill>
              <Pill active={tab === 'services'} onClick={() => { setTab('services') }}>{t('tab.services')}</Pill>
            </nav>
            <div className={css.body}>
              {tab === 'fleet' && (
                <div className={css.stack}>
                  {notice !== undefined && (
                    <p className={css.notice}>
                      {notice}
                      <IconSendOutline16 size={12} className={css.noticeIcon} aria-hidden />
                    </p>
                  )}
                  {feed?.delegations.length === 0 && (
                    <div className={css.empty}>
                      <div className={css.emptyTitle}>{t('fleet.empty.title')}</div>
                      <div>{t('fleet.empty.body')}</div>
                    </div>
                  )}
                  {feed?.delegations.map(d => (
                    <DelegationCard
                      key={d.id}
                      delegation={d}
                      t={t}
                      now={now}
                      onOpen={() => { openSelection({ kind: 'delegation', id: d.id }) }}
                      onStop={() => { setStopTarget(d); setStopAck(false) }}
                    />
                  ))}
                  {agentsError !== undefined
                    ? <p className={css.globalError}>{t('agents.failed', { message: agentsError })}</p>
                    : agents === undefined
                      ? <div className={css.empty}>{t('agents.loading')}</div>
                      : <RosterSection agents={agents} t={t} onOpen={(id) => { openSelection({ kind: 'session', id }) }} />}
                </div>
              )}
              {tab === 'sessions' && (
                <div className={css.stack}>
                  {feed?.sessions.length === 0 && <div className={css.empty}>{t('sessions.empty')}</div>}
                  {feed?.sessions.map(s => (
                    <button
                      type="button"
                      key={s.id}
                      className={css.sessionRow}
                      onClick={() => { openSelection({ kind: 'session', id: s.id }) }}
                    >
                      <span className={css.sessionId}>{s.id.slice(0, 8)}</span>
                      <span className={css.sessionSize}>{`${(s.sizeBytes / 1024).toFixed(1)} KB`}</span>
                      <span className={css.sessionAge}>{t(`time.${ageOf(s.modifiedAt, now).unit}`,
                        { n: ageOf(s.modifiedAt, now).n })}</span>
                    </button>
                  ))}
                </div>
              )}
              {tab === 'heartbeats' && (
                <Heartbeats
                  jobs={heartbeatJobs}
                  error={heartbeatError}
                  agents={agents}
                  api={api}
                  t={t}
                  onChanged={() => { setManualRefresh(n => n + 1) }}
                />
              )}
              {tab === 'services' && (
                <ServicesSection api={api} t={t} onShutdown={afterAction} onError={setActionError} />
              )}
            </div>
            {tab === 'fleet' && <DelegateForm t={t} onDelegate={delegate} />}
          </>
        )}

      <RiskConfirmation
        open={stopTarget !== undefined}
        title={t('stop.confirm.title')}
        description={t('stop.confirm.body')}
        acknowledgeLabel={t('stop.confirm.body')}
        cancelLabel={t('stop.confirm.cancel')}
        confirmLabel={t('stop.confirm.confirm')}
        acknowledged={stopAck}
        onAcknowledgedChange={setStopAck}
        onCancel={() => { setStopTarget(undefined) }}
        onConfirm={() => { void stopConfirmed() }}
      />
    </div>
  )
}

/** The services tab: doctor diagnostics + the shutdown-all confirmation. */
function ServicesSection(props: {
  api: PrimeApi
  t: PrimePanelProps['t']
  onShutdown: () => void
  onError: (message: string | undefined) => void
}) {
  const { t } = props
  const [running, setRunning] = useState(false)
  const [health, setHealth] = useState<{ ok: boolean; doctor: string; status: string } | undefined>(undefined)
  const [shuttingDown, setShuttingDown] = useState(false)
  const [shutdownAck, setShutdownAck] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [inbox, setInbox] = useState<PrimeAgentMessagesStatus | undefined>(undefined)
  const [inboxBusy, setInboxBusy] = useState(false)
  const [inboxError, setInboxError] = useState<string | undefined>(undefined)

  const loadInbox = (): void => {
    setInboxBusy(true)
    setInboxError(undefined)
    props.api.agentMessages({ action: 'status' }).then(
      (result) => {
        setInboxBusy(false)
        setInbox(result.status)
      },
      (error: unknown) => {
        setInboxBusy(false)
        setInboxError(t('services.inbox.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const gateInbox = (paused: boolean): void => {
    setInboxBusy(true)
    setInboxError(undefined)
    props.api.agentMessages({ action: paused ? 'pause' : 'resume' }).then(
      (result) => {
        setInboxBusy(false)
        setInbox(result.status)
      },
      (error: unknown) => {
        setInboxBusy(false)
        setInboxError(t('services.inbox.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const runDoctor = (): void => {
    setRunning(true)
    props.api.doctor().then(
      (result) => {
        setRunning(false)
        setHealth(result)
      },
      (error: unknown) => {
        setRunning(false)
        props.onError(t('services.doctor.unhealthy'))
        setHealth({ ok: false, doctor: error instanceof Error ? error.message : String(error), status: '' })
      })
  }

  const confirmShutdown = (): void => {
    setShuttingDown(true)
    props.api.shutdown().then(
      () => {
        setShuttingDown(false)
        setConfirmOpen(false)
        setShutdownAck(false)
        props.onShutdown()
      },
      (error: unknown) => {
        setShuttingDown(false)
        setConfirmOpen(false)
        setShutdownAck(false)
        props.onError(t('services.shutdown.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  return (
    <div className={css.stack}>
      <div className={css.serviceRow}>
        <Button icon={<IconRefreshOutline16 size={14} />} onClick={runDoctor} disabled={running}>
          {running ? t('services.doctor.running') : t('services.doctor.run')}
        </Button>
        {health !== undefined && (
          <span className={clsx(css.count, health.ok ? css.stateOk : css.stateBad)}>
            {health.ok ? t('services.doctor.healthy') : t('services.doctor.unhealthy')}
          </span>
        )}
      </div>
      {health !== undefined && (
        <section className={css.section}>
          <div className={css.sectionLabel}>{t('services.doctor.output')}</div>
          <TerminalBlock command="prime-agent doctor" output={health.doctor} maxLines={18} />
          {health.status.length > 0 && <TerminalBlock command="prime-agent status" output={health.status} maxLines={10} />}
        </section>
      )}
      <div className={css.serviceRow}>
        <Button variant="outline" icon={<IconStopFill16 size={14} />} onClick={() => { setConfirmOpen(true) }}>
          {t('services.shutdown')}
        </Button>
      </div>
      <section className={css.section}>
        <div className={css.sectionLabel}>{t('services.inbox.title')}</div>
        <div className={css.serviceRow}>
          {inbox === undefined && (
            <Button size="sm" icon={<IconRefreshOutline16 size={14} />} onClick={loadInbox} disabled={inboxBusy}>
              {inboxBusy ? t('detail.heartbeat.loading') : t('services.inbox.load')}
            </Button>
          )}
          {inbox !== undefined && (
            <>
              <span className={clsx(css.count, inbox.paused ? css.stateWarn : css.stateOk)}>
                {inbox.paused ? t('services.inbox.paused') : t('services.inbox.active')}
              </span>
              <Button size="sm" variant="outline" disabled={inboxBusy} onClick={() => { gateInbox(!inbox.paused) }}>
                {inbox.paused ? t('services.inbox.resume') : t('services.inbox.pause')}
              </Button>
            </>
          )}
        </div>
        {inbox !== undefined && (
          <p className={css.cardMeta}>
            {t('services.inbox.limits', { chars: inbox.maxMessageChars, pending: inbox.maxPendingPerSession, capacity: inbox.rateLimitCapacity, refill: inbox.rateLimitRefillMs })}
          </p>
        )}
        {inboxError !== undefined && <p className={css.globalError}>{inboxError}</p>}
      </section>
      <RiskConfirmation
        open={confirmOpen}
        title={t('services.shutdown.confirm.title')}
        description={t('services.shutdown.confirm.body')}
        acknowledgeLabel={t('services.shutdown.confirm.body')}
        cancelLabel={t('stop.confirm.cancel')}
        confirmLabel={t('services.shutdown.confirm.confirm')}
        acknowledged={shutdownAck}
        disabled={shuttingDown}
        onAcknowledgedChange={setShutdownAck}
        onCancel={() => { setConfirmOpen(false) }}
        onConfirm={() => { confirmShutdown() }}
      />
    </div>
  )
}
