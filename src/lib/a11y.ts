import type { KeyboardEvent } from 'react'

export function activateOnKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return

  event.stopPropagation()
  event.preventDefault()
  event.currentTarget.click()
}
