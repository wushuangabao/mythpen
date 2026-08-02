import type { LucideIcon } from 'lucide-react'
import { CheckCircle2, Link2, Loader, Pin, Plus, RefreshCw, Target, X } from 'lucide-react'
import { useState } from 'react'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { aiApi, extractAIJsonArray, foreshadowsApi, getAIResponseText } from '@/lib/api'
import { useChapters, useForeshadows, useProjectName } from '@/lib/useProjectData'

interface Column {
  key: string
  icon: LucideIcon
  label: string
}

interface ForeshadowItem {
  id: string
  title: string
  description?: string
  status: 'planted' | 'progressing' | 'resolved' | 'abandoned'
  priority: 'low' | 'normal' | 'high'
  expected_resolve_chapter?: number
}

const COLUMNS: Column[] = [
  { key: 'planted', icon: Pin, label: 'foreshadow.planted' },
  { key: 'progressing', icon: RefreshCw, label: 'foreshadow.progressing' },
  { key: 'resolved', icon: CheckCircle2, label: 'foreshadow.resolved' },
]

export function Foreshadows() {
  const { data: foreshadows, loading, reload } = useForeshadows()
  useDataRefresh('foreshadow', reload)
  const { chapters } = useChapters()
  const { t } = useT()
  const project = useProjectName()
  const [showCreate, setShowCreate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [selectedForeshadow, setSelectedForeshadow] = useState<ForeshadowItem | null>(null)

  const handleAIDesign = async () => {
    if (!project) return
    setGenerating(true)
    try {
      const res = await aiApi.chat(
        [
          {
            role: 'system',
            content: t('foreshadow.aiPrompt'),
          },
          { role: 'user', content: t('foreshadow.aiUserMessage') },
        ],
        project,
      )
      const text = getAIResponseText(res)
      const suggestions = extractAIJsonArray(text)
      if (suggestions) {
        await Promise.all(
          suggestions.map((s) =>
            foreshadowsApi.create(project, {
              title: s.title,
              description: s.description || '',
              priority: s.priority || 'normal',
              status: 'planted',
            }),
          ),
        )
        reload()
      }
    } catch (e) {
      console.error('AI design foreshadows failed:', e)
    }
    setGenerating(false)
  }

  if (loading)
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  const list = (foreshadows || []) as unknown as ForeshadowItem[]
  const maxChapterNum = Math.max(0, ...(chapters || []).map((c) => c.num))
  const selectedExpectedResolveChapter = selectedForeshadow?.expected_resolve_chapter ?? 0
  const stats = [
    { label: t('foreshadow.statTotal'), value: String(list.length), color: 'var(--accent-gold)' },
    { label: t('foreshadow.planted'), value: String(list.filter((f) => f.status === 'planted').length) },
    { label: t('foreshadow.progressing'), value: String(list.filter((f) => f.status === 'progressing').length) },
    { label: t('foreshadow.resolved'), value: String(list.filter((f) => f.status === 'resolved').length) },
    {
      label: t('foreshadow.overdue'),
      value: String(
        list.filter((f) => {
          const expectedResolveChapter = f.expected_resolve_chapter ?? 0
          return f.status === 'planted' && expectedResolveChapter > 0 && expectedResolveChapter < maxChapterNum
        }).length,
      ),
      color: 'var(--error)',
    },
  ]

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <Link2 className="w-5 h-5" /> {t('pages.foreshadowBoard')}
        </h2>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5"
            style={{ height: 30, padding: '0 14px' }}
            onClick={handleAIDesign}
            disabled={generating}
          >
            {generating ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Target className="w-3.5 h-3.5" />}
            {generating ? t('common.generating') : t('pages.aiDesign')}
          </button>
          <button
            type="button"
            className="btn-secondary flex items-center gap-1"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-3.5 h-3.5" /> {t('pages.manualAdd')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.manualAdd')}`}
          fields={[
            {
              key: 'title',
              label: t('foreshadow.titleField'),
              required: true,
              placeholder: t('foreshadow.titlePlaceholder'),
            },
            {
              key: 'description',
              label: t('foreshadow.descriptionField'),
              type: 'textarea',
              placeholder: t('foreshadow.descriptionPlaceholder'),
            },
            {
              key: 'priority',
              label: t('foreshadow.priorityField'),
              type: 'select',
              options: [
                { value: 'high', label: t('foreshadow.priorityHigh') },
                { value: 'normal', label: t('foreshadow.priorityNormal') },
                { value: 'low', label: t('foreshadow.priorityLow') },
              ],
            },
            {
              key: 'status',
              label: t('foreshadow.statusField'),
              type: 'select',
              options: [
                { value: 'planted', label: t('foreshadow.planted') },
                { value: 'progressing', label: t('foreshadow.progressing') },
              ],
            },
          ]}
          onSubmit={async (vals) => {
            await foreshadowsApi.create(project, vals)
            reload()
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {selectedForeshadow && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4" role="presentation">
          <button
            type="button"
            className="absolute inset-0 cursor-default border-none bg-transparent p-0"
            aria-label={t('foreshadow.closeDetails')}
            onClick={() => setSelectedForeshadow(null)}
          />
          <section
            className="relative z-10 flex max-h-[min(560px,calc(100vh-2rem))] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-[var(--hairline-light)] bg-[var(--canvas-card)] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="foreshadow-detail-title"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--hairline)] px-5 py-4">
              <div className="min-w-0">
                <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-[var(--ink-tertiary)] uppercase">
                  {t('foreshadow.detailTitle')}
                </div>
                <h3
                  id="foreshadow-detail-title"
                  className="break-words font-display text-[20px] font-semibold text-[var(--ink)]"
                >
                  {selectedForeshadow.title}
                </h3>
              </div>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--canvas-mid)] hover:text-[var(--ink)]"
                aria-label={t('foreshadow.closeDetails')}
                onClick={() => setSelectedForeshadow(null)}
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 custom-scrollbar">
              <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-[var(--ink-secondary)] uppercase">
                {t('foreshadow.descriptionField')}
              </div>
              <p className="whitespace-pre-wrap break-words text-[14px] leading-6 text-[var(--ink-secondary)]">
                {selectedForeshadow.description || t('foreshadow.noDescription')}
              </p>

              {selectedExpectedResolveChapter > 0 && (
                <div className="mt-5 border-t border-[var(--hairline)] pt-4 text-[12px] text-[var(--ink-tertiary)]">
                  {t('foreshadow.expectedResolve', { n: selectedExpectedResolveChapter })}
                </div>
              )}
            </div>

            <div className="flex justify-end border-t border-[var(--hairline)] px-5 py-3">
              <button
                type="button"
                className="h-8 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] px-4 text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--canvas-mid)]"
                onClick={() => setSelectedForeshadow(null)}
              >
                {t('foreshadow.closeDetails')}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="flex gap-3 px-6 py-4 shrink-0 bg-[var(--canvas-soft)] border-b border-[var(--hairline)]">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg px-5 py-3 min-w-[100px] text-center"
          >
            <div className="font-mono text-lg" style={{ color: s.color || 'var(--accent-gold)' }}>
              {s.value}
            </div>
            <div className="text-[11px] text-[var(--ink-tertiary)] mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-4 flex-1 px-6 py-4 overflow-x-auto min-h-0 custom-scrollbar">
        {COLUMNS.map((col) => {
          const ColIcon = col.icon
          return (
            <div key={col.key} className="flex-1 min-w-[240px] bg-[var(--canvas-soft)] rounded-lg flex flex-col">
              <div className="px-3.5 py-2.5 text-[13px] font-medium text-[var(--ink-secondary)] border-b border-[var(--hairline)] flex items-center justify-between gap-1.5">
                <span className="flex items-center gap-1">
                  <ColIcon className="w-3.5 h-3.5" /> {t(col.label)}
                </span>
                <span>{list.filter((f) => f.status === col.key).length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                {list
                  .filter((f) => f.status === col.key)
                  .map((f) => {
                    const expectedResolveChapter = f.expected_resolve_chapter ?? 0
                    return (
                      <button
                        type="button"
                        key={f.id}
                        className="mb-1.5 block w-full rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-card)] p-2.5 text-left font-sans transition-colors hover:border-[var(--hairline-light)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-gold)]"
                        aria-label={t('foreshadow.viewDetails', { title: f.title })}
                        onClick={() => setSelectedForeshadow(f)}
                      >
                        <div className="text-[13px] text-[var(--ink)] flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 inline-block
                          ${f.priority === 'high' ? 'bg-[var(--error)]' : f.priority === 'normal' ? 'bg-[var(--accent-gold)]' : 'bg-[var(--ink-mute)]'}`}
                          />
                          {f.title}
                        </div>
                        {f.description && (
                          <div className="text-[12px] text-[var(--ink-tertiary)] mt-1 line-clamp-2">
                            {f.description}
                          </div>
                        )}
                        {expectedResolveChapter > 0 && (
                          <div className="text-[10px] text-[var(--ink-mute)] mt-1 font-mono">
                            {t('foreshadow.expectedResolve', { n: expectedResolveChapter })}
                          </div>
                        )}
                      </button>
                    )
                  })}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
