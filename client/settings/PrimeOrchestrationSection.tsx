/**
 * Prime-orchestration settings section: one form over the `prime-orchestrator`
 * settings namespace — enable/disable, the host-plane overrides (bin, state
 * dir, daemon socket, delegation ceiling), delegation capability defaults,
 * and heartbeat defaults.
 *
 * The form edits a staged draft: keystrokes stage in the controller's store
 * and only the save button writes, so what is on screen is exactly what a save
 * stores. The preset registers the namespace with `applies: 'restart'` and
 * reads the resolved section at mount, so every change takes effect after the
 * deployment restarts. A cleared field is written as empty string/0, which the
 * preset folds back to the composition value.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrimeOrchestrationSectionInjected } from './section-store.ts'
import css from './PrimeOrchestrationSection.module.css'

/** Full component props. */
export type PrimeOrchestrationSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.primeOrchestration'>
  & InjectFace<PrimeOrchestrationSectionInjected>

/** A numeric field renders empty when 0: the preset folds 0 back to the base. */
function numberText(value: number): string {
  return value === 0 ? '' : String(value)
}

/** Parse a numeric field; blank/invalid folds to 0 (inherit/off). */
function parseNumber(value: string): number {
  const trimmed = value.trim()
  if (trimmed === '') return 0
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * Render the Prime-orchestration settings form.
 * @param props - composed slot props.
 * @returns the section, or a short notice while the scope is unavailable.
 */
export function PrimeOrchestrationSection(props: PrimeOrchestrationSectionProps): ReactNode {
  const { usePrimeSettings, t, setDraft, reset, save } = props
  const state = usePrimeSettings(snapshot => snapshot)

  if (state.status === 'loading') {
    return <div className={css.section}><p className={css.note}>{t('loading')}</p></div>
  }
  if (state.status === 'unavailable') {
    return <div className={css.section}><p className={css.note}>{t('unavailable')}</p></div>
  }

  const d = state.draft
  const disabled = !state.writable || state.saving

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      <p className={css.note}>{t('restartNote')}</p>
      {!state.writable ? <p className={css.note}>{t('readOnly')}</p> : null}
      {state.error === null ? null : <p className={css.error} role="alert">{`${t('error')} ${state.error}`}</p>}

      <label className={css.checkRow}>
        <input
          type="checkbox"
          checked={d.enabled}
          disabled={disabled}
          onChange={event => { setDraft('enabled', event.target.checked) }}
        />
        <span className={css.checkLabel}>{t('enable')}</span>
      </label>
      <p className={css.hint}>{t('enableHint')}</p>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('hostConfig')}</h3>
        <div className={css.grid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('bin')}</span>
            <input
              className={css.input}
              value={d.bin}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('optional')}
              onChange={event => { setDraft('bin', event.target.value) }}
            />
            <span className={css.hint}>{t('binHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('stateDir')}</span>
            <input
              className={css.input}
              value={d.stateDir}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('optional')}
              onChange={event => { setDraft('stateDir', event.target.value) }}
            />
            <span className={css.hint}>{t('stateDirHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('daemonSocket')}</span>
            <input
              className={css.input}
              value={d.daemonSocket}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('optional')}
              onChange={event => { setDraft('daemonSocket', event.target.value) }}
            />
            <span className={css.hint}>{t('daemonSocketHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('maxDelegations')}</span>
            <input
              className={css.input}
              type="number"
              min={1}
              step={1}
              value={numberText(d.maxDelegations)}
              disabled={disabled}
              onChange={event => { setDraft('maxDelegations', parseNumber(event.target.value)) }}
            />
            <span className={css.hint}>{t('maxDelegationsHint')}</span>
          </label>
        </div>
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('delegationDefaults')}</h3>
        <div className={css.grid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegateModel')}</span>
            <input
              className={css.input}
              value={d.delegateModel}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('optional')}
              onChange={event => { setDraft('delegateModel', event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegateProvider')}</span>
            <input
              className={css.input}
              value={d.delegateProvider}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('optional')}
              onChange={event => { setDraft('delegateProvider', event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegateThinking')}</span>
            <input
              className={css.input}
              value={d.delegateThinking}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('optional')}
              onChange={event => { setDraft('delegateThinking', event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegateGoalTokenBudget')}</span>
            <input
              className={css.input}
              type="number"
              min={1}
              step={1}
              value={numberText(d.delegateGoalTokenBudget)}
              disabled={disabled}
              placeholder={t('optional')}
              onChange={event => { setDraft('delegateGoalTokenBudget', parseNumber(event.target.value)) }}
            />
          </label>
          <label className={css.checkRow}>
            <input
              type="checkbox"
              checked={d.delegateAutonomous}
              disabled={disabled}
              onChange={event => { setDraft('delegateAutonomous', event.target.checked) }}
            />
            <span className={css.checkLabel}>{t('delegateAutonomous')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('delegateAutonomousMaxContinuations')}</span>
            <input
              className={css.input}
              type="number"
              min={1}
              step={1}
              value={numberText(d.delegateAutonomousMaxContinuations)}
              disabled={disabled}
              placeholder={t('optional')}
              onChange={event => { setDraft('delegateAutonomousMaxContinuations', parseNumber(event.target.value)) }}
            />
          </label>
        </div>
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('heartbeatDefaults')}</h3>
        <div className={css.grid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('heartbeatIntervalMs')}</span>
            <input
              className={css.input}
              type="number"
              min={0}
              step={1}
              value={numberText(d.heartbeatIntervalMs)}
              disabled={disabled}
              placeholder={t('optional')}
              onChange={event => { setDraft('heartbeatIntervalMs', parseNumber(event.target.value)) }}
            />
            <span className={css.hint}>{t('heartbeatIntervalMsHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('heartbeatTimeoutMs')}</span>
            <input
              className={css.input}
              type="number"
              min={0}
              step={1}
              value={numberText(d.heartbeatTimeoutMs)}
              disabled={disabled}
              placeholder={t('optional')}
              onChange={event => { setDraft('heartbeatTimeoutMs', parseNumber(event.target.value)) }}
            />
            <span className={css.hint}>{t('heartbeatTimeoutMsHint')}</span>
          </label>
        </div>
      </section>

      <div className={css.actions}>
        <button
          type="button"
          className={css.saveButton}
          disabled={!state.dirty || disabled}
          onClick={() => { void save() }}
        >
          {state.saving ? t('saving') : t('save')}
        </button>
        {state.dirty ? (
          <button type="button" className={css.resetButton} disabled={disabled} onClick={reset}>
            {t('reset')}
          </button>
        ) : null}
        {state.justSaved ? <span className={css.saved}>{t('saved')}</span> : null}
      </div>
    </div>
  )
}