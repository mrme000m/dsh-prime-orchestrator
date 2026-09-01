// AgentDetail: the drill-in view for one fleet member — a harness
// delegation (live event tail + goal strip + steering over the underlying
// prime session id) or a prime-agent session file (goal-lifecycle forensics
// + trailing summarized events + the current heartbeat). Pure presentation:
// the panel owns the fetch and poll cadence; one-shot mutations (send_message
// and heartbeat_get) call the api face directly and report back through
// onChanged so the panel can refresh.

import { useState } from 'react'
import clsx from 'clsx'
import {
  Button, StateDot, IconChevronLeftOutline14, IconRefreshOutline16, IconSendOutline16, IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PrimeAgent, PrimeApi, PrimeDelegation, PrimeEventSummary, PrimeHeartbeat, PrimeSessionInspection,
} from './api.ts'
import type { Selection } from './PrimePanel.tsx'
import type { PrimePanelProps } from './PrimePanel.tsx'
import css from './PrimePanel.module.css'

/** The detail view's props: the drill-in target and its loaded material. */
export interface AgentDetailProps {
  /** What the user drilled into. */
  selection: Selection
  /** Live delegation record (delegation selections only; absent once dropped from the roster). */
  delegation: PrimeDelegation | undefined
  /** Loaded session inspection (session selections only). */
  inspection: PrimeSessionInspection | undefined
  /** Trailing summarized events (both kinds). */
  events: readonly PrimeEventSummary[] | undefined
  /** The fetch error that replaced the events, when one occurred. */
  error: string | undefined
  /** The roster row for a session selection (its daemon active id drives heartbeat_get). */
  agent: PrimeAgent | undefined
  api: PrimeApi
  t: PrimePanelProps['t']
  onBack: () => void
  /** Open the stop confirmation for the delegation being viewed. */
  onStop: () => void
  /** Called after a successful send or heartbeat action so the panel can refresh. */
  onChanged: () => void
}

/** One event-stream row: type eyebrow over the text/tool/goal facts. */
function EventRow(props: { event: PrimeEventSummary }) {
  const { event } = props
  const goal = event.goalState
  return (
    <div className={css.eventRow}>
      <span className={css.eventType}>
        {event.type}
        {event.role !== undefined && ` · ${event.role}`}
        {event.customType != null && ` · ${event.customType}`}
        {event.toolName !== undefined && ` · ${event.toolName}`}
        {event.toolStatus != null && ` · ${event.toolStatus}`}
        {event.durationMs != null && ` · ${event.durationMs}ms`}
        {event.needsInput === true && ' · needs input'}
      </span>
      {event.objective !== undefined && <span className={clsx(css.eventText, css.eventGoal)}>{event.objective}</span>}
      {event.text !== undefined && <span className={css.eventText}>{event.text}</span>}
      {event.toolCalls !== undefined && event.toolCalls.length > 0 && (
        <span className={css.eventTools}>{event.toolCalls.join(' · ')}</span>
      )}
      {goal != null && goal.status !== null && (
        <span className={clsx(css.eventText, css.eventGoal)}>
          {`goal ${goal.status}`}
          {goal.goalId !== null && ` (${goal.goalId})`}
          {goal.tokensUsed != null && ` · ${goal.tokensUsed} tokens`}
        </span>
      )}
    </div>
  )
}

/**
 * Render the agent detail view.
 * @param props - selection + loaded material + api + callbacks.
 * @returns the detail element tree.
 */
export function AgentDetail(props: AgentDetailProps) {
  const { t, selection, delegation, inspection, agent, api } = props
  const [message, setMessage] = useState('')
  const [delivery, setDelivery] = useState<'steer' | 'follow_up'>('steer')
  const [sending, setSending] = useState(false)
  const [sentStatus, setSentStatus] = useState<'delivered' | 'queued' | undefined>(undefined)
  const [steerError, setSteerError] = useState<string | undefined>(undefined)
  const [heartbeat, setHeartbeat] = useState<PrimeHeartbeat | null | undefined>(undefined)
  const [heartbeatBusy, setHeartbeatBusy] = useState(false)
  const [heartbeatError, setHeartbeatError] = useState<string | undefined>(undefined)

  // Steering addresses the delegation's underlying prime session (the
  // harness delegation id itself does not resolve on the agent-to-agent
  // route); session selections prefer the roster's daemon active id.
  const steerTarget = selection.kind === 'session'
    ? agent?.id ?? selection.id
    : delegation?.sessionId ?? undefined

  // The current-heartbeat section needs a daemon-backed session's active id.
  const heartbeatTarget = selection.kind === 'session' && agent !== undefined && agent.daemonBacked
    ? agent.id ?? undefined
    : undefined

  const send = (): void => {
    const text = message.trim()
    /* v8 ignore next -- UI armor: the box and its enabled button only render with a steer target and a non-empty message. */
    if (steerTarget === undefined) return
    /* v8 ignore next -- UI armor: the send button is disabled while the message is empty. */
    if (text.length === 0) return
    /* v8 ignore next -- UI armor: the send button is disabled while a send is in flight. */
    if (sending) return
    setSending(true)
    setSentStatus(undefined)
    setSteerError(undefined)
    api.sendMessage({ target: steerTarget, message: text, delivery }).then(
      (result) => {
        setSending(false)
        setSentStatus(result.receipt.deliveryStatus)
        setMessage('')
        props.onChanged()
      },
      (error: unknown) => {
        setSending(false)
        setSteerError(t('detail.steer.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const loadHeartbeat = (): void => {
    /* v8 ignore next -- UI armor: the section only renders with a heartbeat target. */
    if (heartbeatTarget === undefined) return
    setHeartbeatBusy(true)
    setHeartbeatError(undefined)
    api.heartbeatGet(heartbeatTarget).then(
      (result) => {
        setHeartbeatBusy(false)
        setHeartbeat(result.heartbeat)
      },
      (error: unknown) => {
        setHeartbeatBusy(false)
        setHeartbeatError(t('detail.heartbeat.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const stop = (): void => {
    props.onStop()
  }

  return (
    <div className={css.detail}>
      <header className={css.detailHead}>
        <button type="button" className={css.back} onClick={props.onBack}>
          <IconChevronLeftOutline14 size={14} aria-hidden />
          {t('detail.back')}
        </button>
        {delegation !== undefined && (
          <span className={css.detailState}>
            <StateDot state={delegation.status === 'running' ? 'ongoing' : delegation.status === 'failed' ? 'error' : delegation.status === 'stopped' ? 'warning' : 'done'} />
            {t(`status.${delegation.status}.label`)}
          </span>
        )}
        {inspection !== undefined && (
          <span className={clsx(css.detailState, inspection.idle ? css.stateWarn : css.stateOk)}>
            {inspection.idle ? t('detail.idle') : t('detail.active')}
          </span>
        )}
      </header>

      {delegation !== undefined && (
        <>
          <p className={css.detailTask}>{delegation.task}</p>
          <div className={css.detailMeta}>
            {`#${delegation.id} · pid ${delegation.pid ?? '—'} · ${delegation.cwd}`}
          </div>
          {delegation.status === 'running' && (
            <div className={css.detailActions}>
              <Button
                size="sm"
                variant="outline"
                icon={<IconStopFill16 size={14} />}
                onClick={stop}
              >
                {t('delegation.stop')}
              </Button>
            </div>
          )}
        </>
      )}
      {inspection !== undefined && (
        <>
          <div className={clsx(css.detailMeta, css.detailMono)}>{inspection.id}</div>
          <div className={clsx(css.goalStrip, inspection.goal != null && inspection.goal.status !== null && css.goalActive)}>
            {(inspection.goal != null && inspection.goal.status !== null
              ? t('detail.goal', { status: inspection.goal.status })
              : t('detail.goal.none'))
              + (inspection.goal?.goalId != null ? ` · ${inspection.goal.goalId}` : '')
              + (inspection.goal?.tokensUsed != null ? ` · ${t('detail.goalTokens', { n: inspection.goal.tokensUsed })}` : '')
              + ` · ${t('detail.lastActivity', { type: inspection.lastActivityType ?? '—' })}`}
          </div>
          {inspection.goalContext !== null && (
            <section className={css.section}>
              <div className={css.sectionLabel}>{t('detail.goalContext')}</div>
              <p className={css.detailTask}>{inspection.goalContext}</p>
            </section>
          )}
        </>
      )}

      {heartbeatTarget !== undefined && (
        <section className={css.section}>
          <div className={css.sectionLabel}>{t('detail.heartbeat.title')}</div>
          {heartbeat === undefined && (
            <Button size="sm" icon={<IconRefreshOutline16 size={14} />} onClick={loadHeartbeat} disabled={heartbeatBusy}>
              {heartbeatBusy ? t('detail.heartbeat.loading') : t('detail.heartbeat.load')}
            </Button>
          )}
          {heartbeat === null && <div className={css.empty}>{t('detail.heartbeat.none')}</div>}
          {heartbeat !== undefined && heartbeat !== null && (
            <div>
              <p className={css.cardMeta}>
                {heartbeat.schedule ?? ''}
                {heartbeat.deliveryMode !== null && ` · ${heartbeat.deliveryMode}`}
                {` · ${t('heartbeats.runs', { n: heartbeat.runCount })}`}
              </p>
              <p className={css.cardTask}>{heartbeat.prompt ?? ''}</p>
              <div className={css.cardActions}>
                <Button size="sm" variant="outline" icon={<IconRefreshOutline16 size={14} />} onClick={loadHeartbeat} disabled={heartbeatBusy}>
                  {t('detail.heartbeat.load')}
                </Button>
              </div>
            </div>
          )}
          {heartbeatError !== undefined && <p className={css.noticeError}>{heartbeatError}</p>}
        </section>
      )}

      <section className={css.section}>
        <div className={css.sectionLabel}>{t('detail.events')}</div>
        {props.error !== undefined && <p className={css.noticeError}>{t('detail.events.failed', { message: props.error })}</p>}
        {props.events === undefined && props.error === undefined && <div className={css.empty}>{t('detail.events.loading')}</div>}
        {props.events?.length === 0 && <div className={css.empty}>{t('detail.events.empty')}</div>}
        <div className={css.eventStream}>
          {props.events?.map((event, index) => <EventRow key={index} event={event} />)}
        </div>
      </section>

      {steerTarget !== undefined && (
        <div className={css.steerBox}>
          <textarea
            className={css.steerInput}
            value={message}
            rows={2}
            placeholder={t('detail.steer.placeholder')}
            onChange={(event) => { setMessage(event.target.value) }}
          />
          <div className={css.hbRow}>
            <span>{t('detail.steer.delivery')}</span>
            <label className={css.hbRadio}><input type="radio" name="steer-delivery" checked={delivery === 'steer'} onChange={() => { setDelivery('steer') }} />{t('detail.steer.delivery.steer')}</label>
            <label className={css.hbRadio}><input type="radio" name="steer-delivery" checked={delivery === 'follow_up'} onChange={() => { setDelivery('follow_up') }} />{t('detail.steer.delivery.follow_up')}</label>
          </div>
          <div className={css.steerRow}>
            {sentStatus !== undefined && <span className={css.stateOk}>{sentStatus === 'queued' ? t('detail.steer.queued') : t('detail.steer.delivered')}</span>}
            {steerError !== undefined && <span className={css.noticeError}>{steerError}</span>}
            <Button
              size="sm"
              variant="primary"
              icon={<IconSendOutline16 size={14} />}
              disabled={sending || message.trim().length === 0}
              onClick={send}
            >
              {sending ? t('detail.steer.sending') : t('detail.steer.send')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
