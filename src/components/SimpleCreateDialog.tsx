import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useT } from '@/hooks/useT'
import { getDialogFocusWrapIndex, getDialogRestoreFocusTarget, isDialogCloseAllowed } from '@/lib/a11y'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  )
}

interface Field {
  key: string
  label: string
  type?: 'text' | 'textarea' | 'select' | 'number'
  options?: { value: string; label: string }[]
  required?: boolean
  placeholder?: string
  defaultValue?: string
  min?: number
  max?: number
  step?: number
}

interface Props {
  title: string
  fields: Field[]
  onSubmit: (values: Record<string, string>) => Promise<void>
  onClose: () => void
  submitLabel?: string
  submittingLabel?: string
  footerStart?: ReactNode
  restoreFocusTarget?: () => HTMLElement | null
}

export function SimpleCreateDialog({
  title,
  fields,
  onSubmit,
  onClose,
  submitLabel,
  submittingLabel,
  footerStart,
  restoreFocusTarget,
}: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {}
    for (const field of fields) {
      if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue
    }
    return defaults
  })
  const [submitting, setSubmitting] = useState(false)
  const { t } = useT()
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const restoreFocusTargetRef = useRef(restoreFocusTarget)
  const titleId = useId()

  restoreFocusTargetRef.current = restoreFocusTarget

  useEffect(() => {
    const activeElement = document.activeElement
    restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null

    const dialog = dialogRef.current
    const initialFocus = dialog ? getFocusableElements(dialog)[0] : null
    ;(initialFocus ?? dialog)?.focus()

    return () => {
      const preferredTarget = restoreFocusTargetRef.current?.() ?? null
      const restoreFocus = getDialogRestoreFocusTarget(preferredTarget, restoreFocusRef.current)
      if (restoreFocus?.isConnected) restoreFocus.focus()
    }
  }, [])

  const update = (key: string, val: string) => setValues((v) => ({ ...v, [key]: val }))

  const requestClose = () => {
    if (isDialogCloseAllowed(submitting)) onClose()
  }

  const handleSubmit = async () => {
    // Check required fields.
    for (const f of fields) {
      if (f.required && !values[f.key]?.trim()) {
        setError(t('common.requiredField', { label: f.label }))
        return
      }
    }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(values)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('project.createFailed'))
      setSubmitting(false)
    }
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return

    const dialog = dialogRef.current
    if (!dialog) return
    const focusableElements = getFocusableElements(dialog)
    if (focusableElements.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }

    const activeIndex = focusableElements.indexOf(document.activeElement as HTMLElement)
    const wrapIndex = getDialogFocusWrapIndex(activeIndex, focusableElements.length, event.shiftKey)
    if (wrapIndex === null) return

    event.preventDefault()
    focusableElements[wrapIndex]?.focus()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[300]" role="presentation">
      <button
        type="button"
        className="absolute inset-0 cursor-default border-none bg-transparent p-0"
        aria-label={t('project.cancel')}
        aria-disabled={submitting}
        onClick={requestClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="relative z-10 bg-[var(--canvas-card)] border border-[var(--hairline-light)] rounded-xl p-6 w-[460px] max-w-[90vw] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <h3 id={titleId} className="font-display text-[20px] font-semibold mb-4">
          {title}
        </h3>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[13px] text-red-500">
            {error}
          </div>
        )}

        <div className="space-y-3 mb-5">
          {fields.map((f) => (
            <div key={f.key}>
              <label
                htmlFor={`simple-create-${f.key}`}
                className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1"
              >
                {f.label}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  id={`simple-create-${f.key}`}
                  className="w-full bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] p-2.5 font-sans text-[13px] text-[var(--ink)] outline-none resize-vertical min-h-[60px] focus:border-[var(--accent-gold)]"
                  placeholder={f.placeholder}
                  value={values[f.key] || ''}
                  onChange={(e) => update(f.key, e.target.value)}
                />
              ) : f.type === 'select' && f.options ? (
                <select
                  id={`simple-create-${f.key}`}
                  className="w-full h-[34px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                  value={values[f.key] || ''}
                  onChange={(e) => update(f.key, e.target.value)}
                >
                  <option value="">{t('common.select')}</option>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`simple-create-${f.key}`}
                  type={f.type === 'number' ? 'number' : 'text'}
                  className="w-full h-[34px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none focus:border-[var(--accent-gold)]"
                  placeholder={f.placeholder}
                  value={values[f.key] || ''}
                  min={f.type === 'number' ? f.min : undefined}
                  max={f.type === 'number' ? f.max : undefined}
                  step={f.type === 'number' ? f.step : undefined}
                  onChange={(e) => update(f.key, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-2 justify-between border-t border-[var(--hairline)] pt-4">
          <div>{footerStart}</div>
          <div className="flex gap-2">
            <button
              type="button"
              className="h-[32px] px-4 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
              aria-disabled={submitting}
              onClick={requestClose}
            >
              {t('project.cancel')}
            </button>
            <button
              type="button"
              className="h-[32px] px-4 rounded-lg border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[13px] cursor-pointer hover:bg-[var(--accent-gold-soft)] disabled:opacity-40"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? (submittingLabel ?? t('common.creating')) : (submitLabel ?? t('common.create'))}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
