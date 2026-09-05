/**
 * Pending-questions banner — the frame-wide safety net for `ask_user_question`.
 *
 * The stock composer takeover rides the live `events.mux` WebSocket and dies
 * silently with it (sleep/wake, tunnel drop): the question stays pending
 * server-side while no form renders anywhere. This banner deliberately does
 * NOT use the event stream — it polls `/prime/api/questions` over plain HTTP
 * (fresh TCP per request, immune to a dead socket) and can answer or cancel
 * any pending question inline through `/prime/api/questions/respond`, with
 * the full option list, per-question custom answers, and skip. It mounts into
 * the layout override's additive `shell.overlay` list slot, so it is visible
 * from every conversation, not just the asking one.
 *
 * @module dsh-prime-orchestrator/client/questions
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { en as questionsEn, zh as questionsZh, type PrimeQuestionsKey } from './locales.ts'
import css from './PendingQuestionsBadge.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Pending-questions banner copy. */
    'primeQuestions': PrimeQuestionsKey
  }
}

/** One option of a pending question (wire shape from /prime/api/questions). */
interface OptionView {
  label: string
  description?: string
}

/** One question of a pending batch (wire shape from /prime/api/questions). */
interface QuestionView {
  id: string
  question: string
  header?: string
  detail?: string
  options?: OptionView[]
  multiSelect?: boolean
}

/** One pending question batch (wire shape from /prime/api/questions). */
export interface PendingView {
  rpcId: string
  sessionId: string
  questions: QuestionView[]
  askedAt: number
  autoAt: number | null
}

/** /prime/api/questions payload. */
interface QuestionsState {
  ok: boolean
  active: boolean
  pending: PendingView[]
}

/** The registration-side face the banner's slot entry injects. */
export interface PendingQuestionsInjected {
  /** Select the asking conversation in the shell, when the sessions service is available. */
  openSession: (sessionId: string) => void
}

/**
 * Banner props: the framework standard kit for the overlay slot plus the
 * locale face plus the injected face.
 */
export type PendingQuestionsBadgeProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'primeQuestions'>
  & InjectFace<PendingQuestionsInjected>

/** Poll cadence; fresh TCP per request keeps it immune to a dead event socket. */
const POLL_MS = 10_000

/** The conventional recommendation suffix rendered as a badge (mirrors the stock client). */
const RECOMMENDED = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

/** mm:ss countdown, or m/h phrasing for longer waits. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** One question's staged draft inside the inline answer form. */
interface AnswerDraft {
  selected: string[]
  custom: string
  skipped: boolean
}

/**
 * The banner. Renders nothing while no question is pending; a compact list
 * with countdowns otherwise; and a full inline answer form on demand.
 * @param props - composed slot props (t + openSession).
 * @returns the banner, or null.
 */
export function PendingQuestionsBadge(props: PendingQuestionsBadgeProps): ReactNode {
  const { t, openSession } = props
  const [pending, setPending] = useState<PendingView[]>([])
  const [answering, setAnswering] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const poll = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/prime/api/questions', { headers: { accept: 'application/json' } })
      if (!res.ok) { setPending([]); return }
      const body = await res.json() as QuestionsState
      setPending(body.ok && Array.isArray(body.pending) ? body.pending : [])
    } catch {
      /* transient network failure: keep the last snapshot */
    }
  }, [])

  useEffect(() => {
    void poll()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll()
    }, POLL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [poll])

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])

  if (pending.length === 0) return null
  const active = pending.find(item => item.rpcId === answering)
  if (active === undefined) {
    return (
      <div className={css.badge} data-prime-questions="">
        <div className={css.head}>
          <span className={css.dot} />
          <span className={css.title}>{t('bannerTitle')}</span>
        </div>
        <ul className={css.list}>
          {pending.map(item => (
            <li key={item.rpcId} className={css.item}>
              <div className={css.itemHead}>
                {item.questions[0]?.header ?? (item.questions[0]?.question ?? '').slice(0, 64)}
              </div>
              <div className={css.itemMeta}>
                <span className={css.session}>{item.sessionId.replace(/^session-/, '').slice(0, 8)}</span>
                <span className={css.count}>{item.questions.length > 1 ? t('questionCount', { n: String(item.questions.length) }) : null}</span>
                <span className={css.auto}>
                  {item.autoAt === null ? t('noAuto') : t('autoIn', { time: formatCountdown(item.autoAt - now) })}
                </span>
              </div>
              <div className={css.itemActions}>
                <button type="button" className={css.button} onClick={() => { openSession(item.sessionId) }}>{t('open')}</button>
                <button type="button" className={css.buttonPrimary} onClick={() => { setAnswering(item.rpcId) }}>{t('answer')}</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return <AnswerCard key={active.rpcId} pending={active} t={t} onDone={() => { setAnswering(null); void poll() }} />
}

/** The injected t face the card needs (narrowed to avoid threading the full kit). */
type Translate = (key: PrimeQuestionsKey, params?: Record<string, string>) => string

/**
 * The inline answer form for one pending batch: options (single/multi),
 * custom answer, skip, submit, cancel.
 * @param props - the pending batch, t, and the completion callback.
 */
function AnswerCard(props: { pending: PendingView; t: Translate; onDone: () => void }): ReactNode {
  const { pending, t, onDone } = props
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() => pending.questions.map(() => ({ selected: [], custom: '', skipped: false })))
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const question = pending.questions[index]
  const draft = drafts[index]
  if (question === undefined || draft === undefined) return null

  const updateDraft = (update: (current: AnswerDraft) => AnswerDraft): void => {
    setDrafts(current => current.map((item, i) => (i === index ? update(item) : item)))
    setError(null)
  }

  const choose = (label: string): void => {
    updateDraft(current => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    })
    if (question.multiSelect !== true && index < pending.questions.length - 1) setIndex(current => current + 1)
  }

  const answered = (item: AnswerDraft): boolean => item.selected.length > 0 || item.custom.trim() !== ''
  const completed = (item: AnswerDraft): boolean => answered(item) || item.skipped

  const send = async (action: { answers: { id: string; selected: string[]; custom?: string }[] } | { cancel: true }): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/prime/api/questions/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rpcId: pending.rpcId, ...action }),
      })
      const body = await res.json().catch(() => ({ ok: false })) as { ok?: boolean; reason?: string }
      if (body.ok !== true) {
        setBusy(false)
        setError(body.reason ?? 'rejected')
        return
      }
      onDone()
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const submit = (): void => {
    const missing = drafts.findIndex(item => !completed(item))
    if (missing >= 0) { setIndex(missing); setError(t('skip')); return }
    void send({
      answers: pending.questions.map((item, i) => {
        const value = drafts[i]
        if (value.skipped) return { id: item.id, selected: [] }
        const custom = value.custom.trim()
        return {
          id: item.id,
          selected: custom === '' || item.multiSelect === true ? value.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    })
  }

  return (
    <div className={css.badge} data-prime-questions-answer={pending.rpcId}>
      <div className={css.head}>
        <span className={css.dot} />
        <span className={css.title}>{question.header ?? t('bannerTitle')}</span>
        {pending.questions.length > 1
          ? <span className={css.pager}>{index + 1} / {pending.questions.length}</span>
          : null}
      </div>
      <div className={css.body}>
        <p className={css.questionText}>{question.question}</p>
        {question.options === undefined || question.options.length === 0 ? null : (
          <div className={css.options}>
            {question.options.map(option => {
              const recommended = RECOMMENDED.test(option.label)
              const checked = draft.selected.includes(option.label)
              return (
                <button
                  type="button"
                  key={option.label}
                  className={checked ? css.optionSelected : css.option}
                  title={option.description}
                  disabled={busy}
                  onClick={() => { choose(option.label) }}
                >
                  <span className={question.multiSelect === true ? css.checkbox : css.number}>
                    {question.multiSelect === true && checked ? '✓' : question.options!.indexOf(option) + 1}
                  </span>
                  <span className={css.optionCopy}>
                    <span className={css.optionLine}>
                      <span className={css.optionLabel}>{option.label.replace(RECOMMENDED, '')}</span>
                      {recommended ? <span className={css.badgeTag}>{t('recommended')}</span> : null}
                    </span>
                    {option.description === undefined ? null : <span className={css.optionDesc}>{option.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <input
          className={css.customInput}
          value={draft.custom}
          disabled={busy}
          placeholder={t('customPlaceholder')}
          onChange={event => {
            const value = event.target.value
            updateDraft(current => ({
              selected: question.multiSelect === true ? current.selected : [],
              custom: value,
              skipped: false,
            }))
          }}
        />
        <label className={css.skipRow}>
          <input
            type="checkbox"
            checked={draft.skipped}
            disabled={busy}
            onChange={event => { updateDraft(current => ({ ...current, skipped: event.target.checked })) }}
          />
          <span>{t('skip')}</span>
        </label>
        {error === null ? null : <p className={css.error} role="alert">{error}</p>}
      </div>
      <div className={css.footer}>
        <button type="button" className={css.button} disabled={busy} onClick={() => { setIndex(Math.max(0, index - 1)) }}>{t('back')}</button>
        <button type="button" className={css.button} disabled={busy} onClick={() => { void send({ cancel: true }) }}>{t('cancelQuestion')}</button>
        <button
          type="button"
          className={css.buttonPrimary}
          disabled={busy}
          onClick={() => { index < pending.questions.length - 1 ? (setIndex(index + 1), setError(null)) : submit() }}
        >
          {busy ? t('submitting') : index < pending.questions.length - 1 ? t('submit').replace(/s$/, '') : t('submit')}
        </button>
      </div>
    </div>
  )
}

/** Re-exported for the client entry's dictionary registration. */
export const bannerLocales = { en: questionsEn, zh: questionsZh }
