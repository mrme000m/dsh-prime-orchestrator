// Heartbeats: the heartbeat-management tab — the daemon's recurring prompts
// (source heartbeat/rlm_heartbeat/cron) with per-job pause/resume/stop/cancel
// and per-session clear, plus the set form (target session, schedule, prompt,
// delivery mode, source). Presentation only: the panel owns the fetch and
// passes jobs/error in; mutations call the api and hand back through
// onChanged so the panel refetches on its own cadence.

import { useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconRefreshOutline16, IconSendOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PrimeAgent, PrimeApi, PrimeHeartbeat, PrimeHeartbeatSetInput } from './api.ts'
import type { PrimePanelProps } from './PrimePanel.tsx'
import { untilOf } from './store.ts'
import { EmptyState, SkeletonRows } from './States.tsx'
import css from './PrimePanel.module.css'

/** The set form's delivery/source choices (presented as two-row radio pairs). */
type Delivery = 'steer' | 'follow_up'
type Source = 'heartbeat' | 'cron'

/** One heartbeat row's action set, derived from its source. */
interface RowActions {
  /** pause|resume toggles for heartbeat rows (cron rows cancel only). */
  toggle: 'pause' | 'resume' | undefined
  /** stop — heartbeat rows only. */
  stop: boolean
  /** cancel — every row. */
  cancel: boolean
  /** clear — the session's persistent heartbeat (heartbeat rows only). */
  clear: boolean
}

/** Which job's mutation is in flight, keyed by job id. */
type Busy = string | undefined

/**
 * The heartbeat tab's props: the panel-owned catalog + error, the roster
 * agents for the target picker, the api face, and the post-mutation hook.
 */
export interface HeartbeatsProps {
  jobs: readonly PrimeHeartbeat[] | undefined
  error: string | undefined
  agents: readonly PrimeAgent[] | undefined
  api: PrimeApi
  t: PrimePanelProps['t']
  /** Called after any successful mutation; the panel refetches the catalog. */
  onChanged: () => void
}

/** The mutation surface for one heartbeat row. */
function rowActionsOf(source: PrimeHeartbeat['source'], status: PrimeHeartbeat['status']): RowActions {
  const heartbeat = source === 'heartbeat' || source === 'rlm_heartbeat'
  return {
    toggle: heartbeat ? (status === 'paused' ? 'resume' : 'pause') : undefined,
    stop: heartbeat,
    cancel: true,
    clear: heartbeat,
  }
}

/**
 * Render the heartbeat tab.
 * @param props - catalog + roster agents + api + refetch hook + locale.
 * @returns the tab body.
 */
export function Heartbeats(props: HeartbeatsProps) {
  const { jobs, error, agents, api, t } = props
  const [busy, setBusy] = useState<Busy>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [setNotice, setSetNotice] = useState(false)
  const [agent, setAgent] = useState('')
  const [schedule, setSchedule] = useState('')
  const [prompt, setPrompt] = useState('')
  const [delivery, setDelivery] = useState<Delivery>('steer')
  const [source, setSource] = useState<Source>('heartbeat')

  const targets = (agents ?? []).filter(a => a.daemonBacked)
  const agentId = (a: PrimeAgent): string => a.id ?? a.sessionId ?? ''
  const canSubmit = submitting
    ? false
    : agent.length > 0 && schedule.trim().length > 0 && prompt.trim().length > 0

  const sourceKey = (job: PrimeHeartbeat): 'heartbeats.source.heartbeat' | 'heartbeats.source.rlm_heartbeat' | 'heartbeats.source.cron' =>
    job.source === 'cron' ? 'heartbeats.source.cron' : job.source === 'rlm_heartbeat' ? 'heartbeats.source.rlm_heartbeat' : 'heartbeats.source.heartbeat'

  const mutate = async (input: Parameters<PrimeApi['heartbeatAction']>[0], key: string): Promise<void> => {
    setActionError(undefined)
    setBusy(key)
    try {
      await api.heartbeatAction(input)
      props.onChanged()
    } catch (cause) {
      setActionError(t('heartbeats.action.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
    setBusy(undefined)
  }

  const submit = (): void => {
    /* v8 ignore next -- UI armor: the submit button is disabled unless canSubmit. */
    if (!canSubmit) return
    setSubmitting(true)
    setFormError(undefined)
    setSetNotice(false)
    const input: PrimeHeartbeatSetInput = { agent, schedule: schedule.trim(), prompt: prompt.trim(), delivery, source }
    void api.heartbeatSet(input).then(
      () => {
        setSubmitting(false)
        setSetNotice(true)
        setPrompt('')
        props.onChanged()
      },
      (cause: unknown) => {
        setSubmitting(false)
        setFormError(t('heartbeats.set.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
      })
  }

  return (
    <div className={css.stack}>
      {error !== undefined
        ? <p className={css.globalError}>{t('heartbeats.failed', { message: error })}</p>
        : jobs === undefined
          ? <SkeletonRows rows={3} label={t('loading.label')} />
          : (
            <>
              {jobs.length === 0 && (
                <EmptyState
                  icon={<IconRefreshOutline16 size={18} />}
                  title={t('heartbeats.empty.title')}
                  body={t('heartbeats.empty.body')}
                />
              )}
              {jobs.map((job) => {
                const actions = rowActionsOf(job.source, job.status)
                const toggle = actions.toggle
                const name = job.sessionName ?? job.firstMessage ?? job.activeSessionId ?? job.id
                return (
                  <article key={job.id ?? job.activeSessionId ?? '?'} className={css.card} data-status={job.status === 'paused' ? 'stopped' : 'running'}>
                    <div className={css.cardHead}>
                      <StateDot state={job.status === 'paused' ? 'warning' : 'ongoing'} />
                      <span className={css.cardState}>{t(sourceKey(job))}{job.status === 'paused' && ` · ${t('heartbeats.status.paused')}`}</span>
                      <span className={css.cardId}>{job.schedule ?? ''}</span>
                    </div>
                    <p className={css.cardTask}>{job.prompt ?? ''}</p>
                    <div className={css.cardMeta}>
                      {name !== null && name}
                      {job.deliveryMode !== null && ` · ${t(`heartbeats.delivery.${job.deliveryMode === 'follow_up' ? 'follow_up' : 'steer'}`)}`}
                      {job.nextRunAt !== null && ` · ${t(`time.in.${untilOf(job.nextRunAt, Date.now()).unit}`, { n: untilOf(job.nextRunAt, Date.now()).n })}`}
                      {` · ${t('heartbeats.runs', { n: job.runCount })}`}
                    </div>
                    {job.lastError !== null && <p className={clsx(css.cardMeta, css.cardError)}>{job.lastError}</p>}
                    <div
                      className={css.cardActions}
                      onClick={(event) => { event.stopPropagation() }}
                      onKeyDown={(event) => { event.stopPropagation() }}
                    >
                      {toggle !== undefined && (
                        <Button size="sm" disabled={busy === job.id} onClick={() => { void mutate({ action: toggle, agent: job.activeSessionId ?? undefined, jobId: job.id ?? undefined }, job.id ?? '') }}>
                          {t(`heartbeats.${toggle}`)}
                        </Button>
                      )}
                      {actions.stop && (
                        <Button size="sm" variant="outline" disabled={busy === job.id} onClick={() => { void mutate({ action: 'stop', agent: job.activeSessionId ?? undefined, jobId: job.id ?? undefined }, job.id ?? '') }}>
                          {t('heartbeats.stop')}
                        </Button>
                      )}
                      {actions.clear && (
                        <Button size="sm" variant="outline" disabled={busy === job.id} onClick={() => { void mutate({ action: 'clear', agent: job.activeSessionId ?? undefined }, job.id ?? '') }}>
                          {t('heartbeats.clear')}
                        </Button>
                      )}
                      {actions.cancel && (
                        <Button size="sm" variant="outline" disabled={busy === job.id} onClick={() => { void mutate({ action: 'cancel', jobId: job.id ?? undefined }, job.id ?? '') }}>
                          {t('heartbeats.cancel')}
                        </Button>
                      )}
                    </div>
                  </article>
                )
              })}
            </>
          )}

      {actionError !== undefined && <p className={css.globalError}>{actionError}</p>}

      <section className={css.section}>
        <div className={css.sectionLabel}>{t('heartbeats.set.title')}</div>
        {targets.length === 0
          ? <div className={css.empty}>{t('heartbeats.set.agent.none')}</div>
          : (
            <div className={css.hbForm}>
              <label className={css.hbField}>
                <span>{t('heartbeats.set.agent')}</span>
                <select className={css.hbSelect} value={agent} onChange={(event) => { setAgent(event.target.value) }}>
                  <option value="">{t('heartbeats.set.agent')}</option>
                  {targets.map(a => (
                    <option key={agentId(a)} value={agentId(a)}>
                      {a.firstMessage ?? agentId(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={css.hbField}>
                <span>{t('heartbeats.set.schedule')}</span>
                <input className={css.hbInput} value={schedule} placeholder={t('heartbeats.set.schedule.placeholder')} onChange={(event) => { setSchedule(event.target.value) }} />
              </label>
              <label className={css.hbField}>
                <span>{t('heartbeats.set.prompt')}</span>
                <input className={css.hbInput} value={prompt} placeholder={t('heartbeats.set.prompt.placeholder')} onChange={(event) => { setPrompt(event.target.value) }} />
              </label>
              <div className={css.hbField}>
                <span>{t('heartbeats.set.delivery')}</span>
                <div className={css.hbRow}>
                  <label className={css.hbRadio}><input type="radio" name="hb-delivery" checked={delivery === 'steer'} onChange={() => { setDelivery('steer') }} />{t('heartbeats.delivery.steer')}</label>
                  <label className={css.hbRadio}><input type="radio" name="hb-delivery" checked={delivery === 'follow_up'} onChange={() => { setDelivery('follow_up') }} />{t('heartbeats.delivery.follow_up')}</label>
                </div>
              </div>
              <div className={css.hbField}>
                <span>{t('heartbeats.set.source')}</span>
                <div className={css.hbRow}>
                  <label className={css.hbRadio}><input type="radio" name="hb-source" checked={source === 'heartbeat'} onChange={() => { setSource('heartbeat') }} />{t('heartbeats.source.heartbeat')}</label>
                  <label className={css.hbRadio}><input type="radio" name="hb-source" checked={source === 'cron'} onChange={() => { setSource('cron') }} />{t('heartbeats.source.cron')}</label>
                </div>
              </div>
              {setNotice && <p className={css.notice}><IconSendOutline16 size={12} className={css.noticeIcon} aria-hidden />{t('heartbeats.set.done')}</p>}
              {formError !== undefined && <p className={css.globalError}>{formError}</p>}
              <Button size="sm" variant="primary" disabled={!canSubmit} onClick={submit}>
                {submitting ? t('heartbeats.set.submitting') : t('heartbeats.set.submit')}
              </Button>
            </div>
          )}
      </section>
    </div>
  )
}
