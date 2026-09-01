// LiveSession: the live control surface for one daemon-backed prime-agent
// session — the web counterpart of its TUI instance. A transcript view
// polled while mounted, a prompt composer (session slash commands work),
// turn-level controls (abort, queue, goal, model), and the attach command
// that hops into the same session from a terminal. Pure presentation and
// its own fetch loop; mutations report through onChanged.

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, TerminalBlock, Tooltip,
  IconRefreshOutline16, IconSendOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PrimeApi, PrimeMessageRow, PrimeModelRow, PrimeQueueResult } from './api.ts'
import type { PrimePanelProps } from './PrimePanel.tsx'
import css from './PrimePanel.module.css'

/** The live-session view's props: the target's daemon active id + api + callbacks. */
export interface LiveSessionProps {
  /** Daemon active session id of the running prime-agent session. */
  agent: string
  api: PrimeApi
  t: PrimePanelProps['t']
  /** Called after a successful mutation so the panel roster can refresh. */
  onChanged: () => void
}

/** One transcript row: role eyebrow over the text. */
function MessageRow(props: { message: PrimeMessageRow }) {
  const { message } = props
  const role = message.tool !== undefined ? `tool · ${message.tool}` : message.role ?? '?'
  return (
    <div className={css.eventRow}>
      <span className={clsx(css.eventType, message.role === 'user' && css.msgUser)}>{role}</span>
      {message.text !== undefined && <span className={css.eventText}>{message.text}</span>}
    </div>
  )
}

/**
 * Render the live session surface.
 * @param props - agent id + api + locale + change callback.
 * @returns the live session element tree.
 */
export function LiveSession(props: LiveSessionProps) {
  const { t, agent, api } = props
  const [messages, setMessages] = useState<PrimeMessageRow[] | undefined>(undefined)
  const [queue, setQueue] = useState<PrimeQueueResult | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [prompt, setPrompt] = useState('')
  const [delivery, setDelivery] = useState<'queue' | 'steer' | 'follow_up'>('queue')
  const [prompting, setPrompting] = useState(false)
  const [promptStatus, setPromptStatus] = useState<string | undefined>(undefined)
  const [promptError, setPromptError] = useState<string | undefined>(undefined)
  const [goal, setGoal] = useState('')
  const [goalBusy, setGoalBusy] = useState(false)
  const [goalStatus, setGoalStatus] = useState<string | undefined>(undefined)
  const [models, setModels] = useState<PrimeModelRow[] | undefined>(undefined)
  const [modelChoice, setModelChoice] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const [modelStatus, setModelStatus] = useState<string | undefined>(undefined)
  const [exportPath, setExportPath] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const streamRef = useRef<HTMLDivElement | null>(null)

  const load = (): void => {
    api.messages(agent).then(
      (result) => { setMessages(result.messages ?? []); setLoadError(undefined) },
      (error: unknown) => { setLoadError(error instanceof Error ? error.message : String(error)) })
    api.queue(agent).then(setQueue, () => { setQueue(undefined) })
  }

  // Transcript poll: 5s while mounted (the panel's roster poll is slower and
  // does not carry the conversation).
  useEffect(() => {
    load()
    const timer = window.setInterval(load, 5_000)
    return () => { window.clearInterval(timer) }
  }, [agent])

  // Keep the newest row visible when the transcript grows.
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight })
  }, [messages])

  const sendPrompt = (): void => {
    const text = prompt.trim()
    if (text.length === 0 || prompting) return
    setPrompting(true)
    setPromptStatus(undefined)
    setPromptError(undefined)
    api.prompt({
      agent,
      message: text,
      ...(delivery === 'queue' ? {} : { delivery }),
    }).then(
      () => {
        setPrompting(false)
        setPrompt('')
        setPromptStatus(t('live.prompt.sent'))
        window.setTimeout(load, 800)
        props.onChanged()
      },
      (error: unknown) => {
        setPrompting(false)
        setPromptError(t('live.prompt.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const runGoalAction = (op: 'pause' | 'resume' | 'clear' | 'stop' | 'status' | 'set'): void => {
    if (goalBusy) return
    if (op === 'set' && goal.trim().length === 0) return
    setGoalBusy(true)
    setGoalStatus(undefined)
    setActionError(undefined)
    const request = op === 'set'
      ? api.goalSet({ agent, goal: goal.trim() })
      : api.goalAction(agent, op)
    request.then(
      () => {
        setGoalBusy(false)
        setGoalStatus(t(`live.goal.${op}`))
        if (op === 'set') setGoal('')
        props.onChanged()
      },
      (error: unknown) => {
        setGoalBusy(false)
        setActionError(t('live.action.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const loadModels = (): void => {
    if (modelBusy || models !== undefined) return
    setModelBusy(true)
    api.models(agent).then(
      (result) => {
        setModelBusy(false)
        setModels(result.models)
        if (result.models.length > 0) setModelChoice(`${result.models[0].provider}/${result.models[0].id}`)
      },
      (error: unknown) => {
        setModelBusy(false)
        setActionError(t('live.action.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const applyModel = (mode: 'select' | 'forward' | 'backward'): void => {
    if (modelBusy) return
    if (mode === 'select' && modelChoice.length === 0) return
    setModelBusy(true)
    setModelStatus(undefined)
    const separator = modelChoice.lastIndexOf('/')
    const request = mode === 'select'
      ? api.setModel({ agent, provider: modelChoice.slice(0, separator), modelId: modelChoice.slice(separator + 1) })
      : api.setModel({ agent, cycle: mode })
    request.then(
      () => {
        setModelBusy(false)
        setModelStatus(t('live.model.set'))
        props.onChanged()
      },
      (error: unknown) => {
        setModelBusy(false)
        setActionError(t('live.action.failed', { message: error instanceof Error ? error.message : String(error) }))
      })
  }

  const abortTurn = (): void => {
    setActionError(undefined)
    api.abort(agent).then(
      () => { window.setTimeout(load, 800); props.onChanged() },
      (error: unknown) => { setActionError(t('live.action.failed', { message: error instanceof Error ? error.message : String(error) })) })
  }

  const clearQueue = (): void => {
    setActionError(undefined)
    api.queueAction(agent, 'clear').then(
      () => { window.setTimeout(load, 800) },
      (error: unknown) => { setActionError(t('live.action.failed', { message: error instanceof Error ? error.message : String(error) })) })
  }

  const exportTranscript = (): void => {
    setActionError(undefined)
    api.exportSession(agent, 'jsonl').then(
      (result) => { setExportPath(result.path ?? undefined) },
      (error: unknown) => { setActionError(t('live.action.failed', { message: error instanceof Error ? error.message : String(error) })) })
  }

  const pending = (queue?.steering.length ?? 0) + (queue?.followUp.length ?? 0)

  return (
    <>
      <section className={css.section}>
        <div className={css.sectionLabel}>
          {t('live.transcript')}
          {pending > 0 && ` · ${t('live.queue.pending', { n: pending })}`}
        </div>
        {loadError !== undefined && <p className={css.noticeError}>{t('live.transcript.failed', { message: loadError })}</p>}
        {messages === undefined && loadError === undefined && <div className={css.empty}>{t('live.transcript.loading')}</div>}
        {messages?.length === 0 && <div className={css.empty}>{t('live.transcript.empty')}</div>}
        <div className={clsx(css.eventStream, css.msgStream)} ref={streamRef}>
          {messages?.map((message, index) => <MessageRow key={index} message={message} />)}
        </div>
      </section>

      <section className={css.section}>
        <div className={css.sectionLabel}>{t('live.controls')}</div>
        <div className={css.cardActions}>
          <Button size="sm" variant="outline" icon={<IconRefreshOutline16 size={14} />} onClick={abortTurn}>
            {t('live.abort')}
          </Button>
          <Button size="sm" variant="outline" onClick={clearQueue}>{t('live.queue.clear')}</Button>
          <Button size="sm" variant="outline" onClick={exportTranscript}>{t('live.export')}</Button>
        </div>
        {exportPath !== undefined && <p className={css.detailMono}>{exportPath}</p>}
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="prime-goal-input">{t('live.goal.label')}</label>
          <input
            id="prime-goal-input"
            className={css.fieldInput}
            value={goal}
            placeholder={t('live.goal.placeholder')}
            onChange={(event) => { setGoal(event.target.value) }}
          />
        </div>
        <div className={css.cardActions}>
          <Button size="sm" variant="primary" disabled={goalBusy || goal.trim().length === 0} onClick={() => { runGoalAction('set') }}>
            {t('live.goal.set')}
          </Button>
          {(['pause', 'resume', 'clear', 'status'] as const).map(op => (
            <Button key={op} size="sm" variant="outline" disabled={goalBusy} onClick={() => { runGoalAction(op) }}>
              {t(`live.goal.${op}`)}
            </Button>
          ))}
        </div>
        {goalStatus !== undefined && <p className={css.stateOk}>{goalStatus}</p>}
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="prime-model-select">{t('live.model.label')}</label>
          <div className={css.cardActions}>
            <Button size="sm" variant="outline" icon={<IconRefreshOutline16 size={14} />} disabled={modelBusy} onClick={loadModels}>
              {models === undefined ? t('live.model.load') : t('live.model.refresh')}
            </Button>
            {models !== undefined && (
              <select
                id="prime-model-select"
                className={css.hbSelect}
                value={modelChoice}
                onChange={(event) => { setModelChoice(event.target.value) }}
              >
                {models.map((model, index) => (
                  <option key={index} value={`${model.provider}/${model.id}`}>
                    {`${model.name ?? model.id} (${model.provider})`}
                  </option>
                ))}
              </select>
            )}
            {models !== undefined && (
              <>
                <Button size="sm" variant="primary" disabled={modelBusy || modelChoice.length === 0} onClick={() => { applyModel('select') }}>
                  {t('live.model.apply')}
                </Button>
                <Tooltip label={t('live.model.cycleHint')}>
                  <Button size="sm" variant="outline" disabled={modelBusy} onClick={() => { applyModel('forward') }}>
                    {t('live.model.cycle')}
                  </Button>
                </Tooltip>
              </>
            )}
          </div>
        </div>
        {modelStatus !== undefined && <p className={css.stateOk}>{modelStatus}</p>}
        {actionError !== undefined && <p className={css.noticeError}>{actionError}</p>}
      </section>

      <div className={css.steerBox}>
        <textarea
          className={css.steerInput}
          value={prompt}
          rows={2}
          placeholder={t('live.prompt.placeholder')}
          onChange={(event) => { setPrompt(event.target.value) }}
        />
        <div className={css.hbRow}>
          <span>{t('detail.steer.delivery')}</span>
          <label className={css.hbRadio}>
            <input type="radio" name="prime-prompt-delivery" checked={delivery === 'queue'} onChange={() => { setDelivery('queue') }} />
            {t('live.prompt.queue')}
          </label>
          <label className={css.hbRadio}>
            <input type="radio" name="prime-prompt-delivery" checked={delivery === 'steer'} onChange={() => { setDelivery('steer') }} />
            {t('detail.steer.delivery.steer')}
          </label>
          <label className={css.hbRadio}>
            <input type="radio" name="prime-prompt-delivery" checked={delivery === 'follow_up'} onChange={() => { setDelivery('follow_up') }} />
            {t('detail.steer.delivery.follow_up')}
          </label>
        </div>
        <div className={css.steerRow}>
          {promptStatus !== undefined && <span className={css.stateOk}>{promptStatus}</span>}
          {promptError !== undefined && <span className={css.noticeError}>{promptError}</span>}
          <Button
            size="sm"
            variant="primary"
            icon={<IconSendOutline16 size={14} />}
            disabled={prompting || prompt.trim().length === 0}
            onClick={sendPrompt}
          >
            {prompting ? t('detail.steer.sending') : t('live.prompt.send')}
          </Button>
        </div>
      </div>

      <section className={css.section}>
        <div className={css.sectionLabel}>{t('live.attach')}</div>
        <TerminalBlock command={`prime-agent attach ${agent}`} output={t('live.attach.hint')} maxLines={4} />
      </section>
    </>
  )
}
