import type { KeyboardEvent } from 'react'

export function activateOnKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return

  event.stopPropagation()
  event.preventDefault()
  event.currentTarget.click()
}

export function getDialogFocusWrapIndex(
  activeIndex: number,
  focusableCount: number,
  backwards: boolean,
): number | null {
  if (focusableCount < 1) return null
  if (activeIndex < 0) return backwards ? focusableCount - 1 : 0
  if (backwards && activeIndex === 0) return focusableCount - 1
  if (!backwards && activeIndex === focusableCount - 1) return 0
  return null
}

export function isDialogCloseAllowed(submitting: boolean): boolean {
  return !submitting
}

export function getDialogRestoreFocusTarget<T>(preferred: T | null, original: T | null): T | null {
  return preferred ?? original
}
