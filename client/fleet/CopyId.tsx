// CopyId: the shared one-tap id copy button. Icon-only and quiet at rest;
// on click it writes the value to the system clipboard (with a hidden
// textarea fallback for non-secure contexts where the async clipboard API
// is unavailable) and flips to a brief checkmark so the copy is confirmed
// without stealing space from the row it lives in. Clicks stop propagation
// so it can sit inside clickable cards and rows without opening them.

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16, IconCopyOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PrimePanelProps } from './PrimePanel.tsx'
import css from './PrimePanel.module.css'

/** How long the copied checkmark stays visible after a successful copy (ms). */
const COPIED_MS = 1200

/**
 * Write text to the clipboard. Tries the async clipboard API first, then
 * falls back to a transient selected textarea for non-secure contexts.
 * @param text - the value to place on the clipboard.
 * @returns true when a write path succeeded.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Non-secure context or permission denied — try the legacy path.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

/** CopyId props: the value to copy plus the locale seat for its labels. */
export interface CopyIdProps {
  /** The id (or any text) placed on the clipboard on click. */
  value: string
  t: PrimePanelProps['t']
  /** Extra class names for the button. */
  className?: string
}

/**
 * Render the small copy-to-clipboard button for one id.
 * @param props - value + locale + optional class.
 * @returns the button element.
 */
export function CopyId(props: CopyIdProps) {
  const { value, t } = props
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  // Clear the pending un-checkmark timer on unmount.
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])

  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    event.preventDefault()
    void writeClipboard(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { setCopied(false) }, COPIED_MS)
    })
  }

  return (
    <button
      type="button"
      className={clsx(css.copyId, props.className)}
      data-copied={copied || undefined}
      aria-label={t('copy.id', { id: value })}
      title={copied ? t('copy.copied') : t('copy.id', { id: value })}
      onClick={onClick}
    >
      {copied ? <IconCheckOutline16 size={12} /> : <IconCopyOutline16 size={12} />}
    </button>
  )
}
