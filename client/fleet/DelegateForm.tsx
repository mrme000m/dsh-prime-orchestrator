// DelegateForm: the pinned composer that starts one background prime-agent
// session. Task + working directory + persistent goal stay always visible;
// the CLI's remaining capability flags collapse behind one disclosure.
// Drafts are component-local (the form unmounts with its tab, not with a
// poll); submit validates client-side, then hands the input to the panel's
// delegate callback (the api call and its error surfacing live up there).

import { useState } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutline14, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PrimeDelegateInput } from './api.ts'
import { parseFlagList, parsePositiveInt } from './store.ts'
import type { PrimePanelProps } from './PrimePanel.tsx'
import css from './PrimePanel.module.css'

/** The form's props: the locale seat + the validated-submit callback. */
export interface DelegateFormProps {
  t: PrimePanelProps['t']
  onDelegate: (input: PrimeDelegateInput) => Promise<void>
}

/** Local draft of the always-visible fields. */
interface Draft {
  task: string
  cwd: string
  goal: string
  model: string
}

/** Local draft of the collapsed capability-flag fields. */
interface Flags {
  provider: string
  thinking: string
  resume: string
  gates: string
  maxTurns: string
  maxTokens: string
  timeoutMs: string
  autonomous: boolean
  offline: boolean
}

/** The autonomous block's exact optional shape (exactOptionalPropertyTypes-safe). */
type AutonomousFlags = { autonomous: true } & Partial<Pick<PrimeDelegateInput,
  'autonomousGates' | 'autonomousMaxTurns' | 'autonomousMaxTokens' | 'autonomousTimeoutMs'>>

const EMPTY_DRAFT: Draft = { task: '', cwd: '', goal: '', model: '' }
const EMPTY_FLAGS: Flags = {
  provider: '', thinking: '', resume: '', gates: '', maxTurns: '', maxTokens: '', timeoutMs: '',
  autonomous: false, offline: false,
}

/**
 * Render the delegate composer.
 * @param props - locale seat + submit callback.
 * @returns the form element tree.
 */
export function DelegateForm({ t, onDelegate }: DelegateFormProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [flags, setFlags] = useState<Flags>(EMPTY_FLAGS)
  const [expanded, setExpanded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = (): void => {
    const task = draft.task.trim()
    /* v8 ignore next -- UI armor: the submit button is disabled while the task is empty or a submit is in flight. */
    if (task.length === 0 || submitting) return
    const maxTurns = parsePositiveInt(flags.maxTurns)
    const maxTokens = parsePositiveInt(flags.maxTokens)
    const timeoutMs = parsePositiveInt(flags.timeoutMs)
    if (flags.maxTurns.trim().length > 0 && maxTurns === undefined
      || flags.maxTokens.trim().length > 0 && maxTokens === undefined
      || flags.timeoutMs.trim().length > 0 && timeoutMs === undefined) {
      setError(t('delegate.failed', { message: 'positive integers required' }))
      setExpanded(true)
      return
    }
    const gates = parseFlagList(flags.gates)
    const autonomous: AutonomousFlags | undefined = flags.autonomous
      ? {
        autonomous: true,
        ...(gates !== undefined ? { autonomousGates: gates } : {}),
        ...(maxTurns !== undefined ? { autonomousMaxTurns: maxTurns } : {}),
        ...(maxTokens !== undefined ? { autonomousMaxTokens: maxTokens } : {}),
        ...(timeoutMs !== undefined ? { autonomousTimeoutMs: timeoutMs } : {}),
      }
      : undefined
    const input: PrimeDelegateInput = {
      task,
      ...(draft.cwd.trim().length > 0 ? { cwd: draft.cwd.trim() } : {}),
      ...(draft.goal.trim().length > 0 ? { goal: draft.goal.trim() } : {}),
      ...(draft.model.trim().length > 0 ? { model: draft.model.trim() } : {}),
      ...(flags.provider.trim().length > 0 ? { provider: flags.provider.trim() } : {}),
      ...(flags.thinking.trim().length > 0 ? { thinking: flags.thinking.trim() } : {}),
      ...(flags.resume.trim().length > 0 ? { resume: flags.resume.trim() } : {}),
      ...(flags.offline ? { offline: true } : {}),
      ...(autonomous !== undefined ? autonomous : {}),
    }
    setSubmitting(true)
    setError(undefined)
    onDelegate(input).then(
      () => {
        setSubmitting(false)
        setDraft(EMPTY_DRAFT)
        setFlags(EMPTY_FLAGS)
        setExpanded(false)
      },
      (submitError: unknown) => {
        setSubmitting(false)
        setError(t('delegate.failed', { message: submitError instanceof Error ? submitError.message : String(submitError) }))
      })
  }

  return (
    <footer className={css.delegateForm}>
      <button
        type="button"
        className={css.delegateToggle}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconPlusOutline16 size={14} className={clsx(css.delegatePlus, open && css.delegatePlusOpen)} aria-hidden />
        {t('delegate.open')}
      </button>
      {open && (
        <>
          <textarea
            className={css.taskInput}
            value={draft.task}
            placeholder={t('delegate.task.placeholder')}
            rows={3}
            onChange={(event) => { setDraft({ ...draft, task: event.target.value }) }}
          />
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegate.cwd')}</span>
            <input
              className={css.fieldInput}
              value={draft.cwd}
              placeholder={t('delegate.cwd.placeholder')}
              onChange={(event) => { setDraft({ ...draft, cwd: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegate.goal')}</span>
            <input
              className={css.fieldInput}
              value={draft.goal}
              placeholder={t('delegate.goal.placeholder')}
              onChange={(event) => { setDraft({ ...draft, goal: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegate.model')}</span>
            <input
              className={css.fieldInput}
              value={draft.model}
              placeholder={t('delegate.model.placeholder')}
              onChange={(event) => { setDraft({ ...draft, model: event.target.value }) }}
            />
          </label>
          <button
            type="button"
            className={clsx(css.delegateToggle, css.delegateMore)}
            aria-expanded={expanded}
            onClick={() => { setExpanded(!expanded) }}
          >
            <IconChevronDownOutline14 size={14} className={clsx(css.chevron, expanded && css.chevronOpen)} aria-hidden />
            {t('delegate.more')}
          </button>
          {expanded && (
            <div className={css.flagGrid}>
              <label className={css.field}>
                <span className={css.fieldLabel}>--provider</span>
                <input
                  className={css.fieldInput}
                  value={flags.provider}
                  onChange={(event) => { setFlags({ ...flags, provider: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>--thinking</span>
                <input
                  className={css.fieldInput}
                  value={flags.thinking}
                  onChange={(event) => { setFlags({ ...flags, thinking: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>--resume</span>
                <input
                  className={css.fieldInput}
                  value={flags.resume}
                  onChange={(event) => { setFlags({ ...flags, resume: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('delegate.autonomousGates')}</span>
                <input
                  className={css.fieldInput}
                  value={flags.gates}
                  onChange={(event) => { setFlags({ ...flags, gates: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('delegate.autonomousMaxTurns')}</span>
                <input
                  className={css.fieldInput}
                  inputMode="numeric"
                  value={flags.maxTurns}
                  onChange={(event) => { setFlags({ ...flags, maxTurns: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('delegate.autonomousMaxTokens')}</span>
                <input
                  className={css.fieldInput}
                  inputMode="numeric"
                  value={flags.maxTokens}
                  onChange={(event) => { setFlags({ ...flags, maxTokens: event.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('delegate.autonomousTimeoutMs')}</span>
                <input
                  className={css.fieldInput}
                  inputMode="numeric"
                  value={flags.timeoutMs}
                  onChange={(event) => { setFlags({ ...flags, timeoutMs: event.target.value }) }}
                />
              </label>
              <label className={clsx(css.field, css.checkField)}>
                <input
                  type="checkbox"
                  checked={flags.autonomous}
                  onChange={(event) => { setFlags({ ...flags, autonomous: event.target.checked }) }}
                />
                <span className={css.fieldLabel}>{t('delegate.autonomous')}</span>
              </label>
              <label className={clsx(css.field, css.checkField)}>
                <input
                  type="checkbox"
                  checked={flags.offline}
                  onChange={(event) => { setFlags({ ...flags, offline: event.target.checked }) }}
                />
                <span className={css.fieldLabel}>--offline</span>
              </label>
            </div>
          )}
          {error !== undefined && <p className={css.noticeError}>{error}</p>}
          <Button
            variant="primary"
            size="sm"
            disabled={submitting || draft.task.trim().length === 0}
            onClick={submit}
          >
            {submitting ? t('delegate.submitting') : t('delegate.submit')}
          </Button>
        </>
      )}
    </footer>
  )
}
