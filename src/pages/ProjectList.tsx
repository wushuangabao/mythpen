import { AlertTriangle, BookOpen, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ManuscriptMigrationDialog } from '@/components/ManuscriptMigrationDialog'
import { ProjectIcon } from '@/components/ProjectIcon'
import { useT } from '@/hooks/useT'
import { activateOnKeyDown } from '@/lib/a11y'
import { type FilesBetaProjectStatus, projectsApi } from '@/lib/api'
import { type ProductionMigrationPreflight, productionManuscriptMigration } from '@/lib/manuscriptMigrationComposition'
import { recoveryReasonI18nKey } from '@/lib/projectRecovery'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return dateStr
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return dateStr
  }
}

export function ProjectList() {
  const { projects, setCurrentProject, showProjectList, deleteProject } = useProjectStore()
  const { setProjectDialogOpen } = useUIStore()
  const { t } = useT()
  const totalWords = projects.reduce((s, p) => s + p.wordCount, 0)

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [filesRoutes, setFilesRoutes] = useState<Record<string, FilesBetaProjectStatus['route']>>({})
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
  const [migrationPreflight, setMigrationPreflight] = useState<ProductionMigrationPreflight | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [migrationError, setMigrationError] = useState<string | null>(null)
  const deleteTargetProject = projects.find((project) => project.name === deleteTarget)

  useEffect(() => {
    let cancelled = false
    const ready = projects.filter((project) => project.openState === 'ready')
    void Promise.all(
      ready.map(async (project) => {
        try {
          return [project.name, (await projectsApi.getFilesBetaStatus(project.name)).route] as const
        } catch {
          return null
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      setFilesRoutes(
        Object.fromEntries(
          entries.filter((entry): entry is readonly [string, FilesBetaProjectStatus['route']] => entry !== null),
        ),
      )
    })
    return () => {
      cancelled = true
    }
  }, [projects])

  if (!showProjectList) return null

  const handleDelete = async () => {
    if (!deleteTarget || deleteTargetProject?.openState !== 'ready') return
    const name = deleteTarget
    setDeleteTarget(null)
    await deleteProject(name)
  }

  const openMigration = async (name: string) => {
    const project = projects.find((candidate) => candidate.name === name)
    if (!project?.instanceId) return
    setMigrationBusy(true)
    setMigrationError(null)
    try {
      const preflight = await productionManuscriptMigration.beginPreflight({
        projectName: name,
        projectInstanceId: project.instanceId,
      })
      setMigrationTarget(name)
      setMigrationPreflight(preflight)
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationBusy(false)
    }
  }

  const confirmMigration = async () => {
    if (!migrationTarget || !migrationPreflight) return
    const name = migrationTarget
    setMigrationBusy(true)
    setMigrationError(null)
    try {
      await productionManuscriptMigration.confirm(migrationPreflight)
      setFilesRoutes((routes) => ({ ...routes, [name]: 'files' }))
      useChapterStore.getState().discardProjectState(name)
      setCurrentProject(name)
      await useChapterStore.getState().loadChapters(name)
      setMigrationTarget(null)
      setMigrationPreflight(null)
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationBusy(false)
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-16 py-12 flex justify-center custom-scrollbar">
        <div className="w-full max-w-[800px]">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="font-display text-[36px] font-semibold leading-[1.2]">{t('project.list')}</h1>
              <div className="text-[var(--ink-tertiary)] text-[13px] mt-1">
                {t('project.total', { count: projects.length, words: totalWords.toLocaleString() })}
              </div>
            </div>
            <button type="button" className="btn-primary h-[34px] px-5" onClick={() => setProjectDialogOpen(true)}>
              + {t('project.new')}
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-16 h-16 mb-6 rounded-2xl bg-[var(--canvas-card)] border border-[var(--hairline)] flex items-center justify-center text-[32px] text-[var(--ink-tertiary)]">
                <BookOpen size={32} />
              </div>
              <h2 className="font-display text-[22px] font-semibold text-[var(--ink)] mb-2">
                {t('project.noProjectsTitle')}
              </h2>
              <p className="text-[var(--ink-tertiary)] text-[14px] max-w-[320px] leading-relaxed">
                {t('project.noProjectsDesc')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              {projects.map((p) => (
                /* biome-ignore lint/a11y/useSemanticElements: the project card contains a separate delete button. */
                <div
                  key={p.id}
                  className={`group relative bg-[var(--canvas-card)] border rounded-lg p-5 cursor-pointer transition-all hover:bg-[var(--canvas-elevated)] hover:-translate-y-px ${
                    p.openState === 'isolated'
                      ? 'border-amber-500/50 hover:border-amber-500/70'
                      : 'border-[var(--hairline)] hover:border-[var(--hairline-light)]'
                  }`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={activateOnKeyDown}
                  onClick={() => setCurrentProject(p.name)}
                >
                  {p.openState === 'ready' && (
                    <button
                      type="button"
                      className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-[var(--canvas-mid)] text-[var(--ink-tertiary)] hover:text-red-500 transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(p.name)
                      }}
                      title={t('project.deleteTooltip')}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}

                  <div className="mb-2.5">
                    <ProjectIcon name={p.iconName} className="w-7 h-7" />
                  </div>
                  <div className="font-display text-lg font-medium text-[var(--ink)] mb-1">{p.name}</div>
                  {p.openState === 'isolated' && (
                    <div className="mb-2.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                      <div className="mb-1 flex items-center gap-1 font-medium">
                        <AlertTriangle size={12} />
                        {t('recovery.isolated')}
                      </div>
                      <div>{t(recoveryReasonI18nKey(p.reasonCode))}</div>
                    </div>
                  )}
                  <div className="flex gap-1 flex-wrap mb-2.5">
                    {p.genres.map((g) => (
                      <span
                        key={g}
                        className="text-[10px] px-[6px] py-[1px] rounded-full bg-[var(--canvas-mid)] text-[var(--ink-tertiary)]"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-3 mb-2 pt-2 border-t border-[var(--hairline)] text-[11px] text-[var(--ink-tertiary)]">
                    <span>
                      {p.wordCount.toLocaleString()} {t('editor.words')}
                    </span>
                    <span>
                      {p.chapterCount} {t('project.chapterUnit')}
                    </span>
                    <span>{t('project.updatedAt', { date: formatDate(p.lastOpened) })}</span>
                  </div>
                  <div className="text-[11px] text-[var(--ink-mute)]">
                    {t(`project.mode.${p.mode}`)} · {t(`status.${p.status}`)}
                  </div>
                  {p.openState === 'ready' && filesRoutes[p.name] === 'sqlite' && (
                    <button
                      type="button"
                      className="mt-3 rounded-md border border-[var(--accent-gold)]/40 px-2.5 py-1.5 text-[11px] font-medium text-[var(--accent-gold)] hover:bg-[var(--accent-gold)]/10"
                      onClick={(event) => {
                        event.stopPropagation()
                        void openMigration(p.name)
                      }}
                    >
                      {t('project.filesBetaMigrate')}
                    </button>
                  )}
                  {p.openState === 'ready' && filesRoutes[p.name] === 'files' && (
                    <div className="mt-3 text-[11px] font-medium text-[var(--accent-gold)]">
                      {t('project.filesBetaActive')}
                    </div>
                  )}
                  {p.openState === 'ready' &&
                    (filesRoutes[p.name] === 'migrating' || filesRoutes[p.name] === 'retired') && (
                      <div className="mt-3 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                        {t('project.filesBetaRecoveryRequired')}
                      </div>
                    )}
                </div>
              ))}

              {/* New project card */}
              <button
                type="button"
                className="flex min-h-[160px] items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--hairline-light)] bg-transparent text-[13px] text-[var(--ink-tertiary)] cursor-pointer flex-col transition-colors hover:border-[var(--accent-gold)] hover:text-[var(--accent-gold)] hover:bg-[var(--canvas-card)]"
                onClick={() => setProjectDialogOpen(true)}
              >
                <span className="text-[28px] leading-none">+</span>
                <span>{t('project.new')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && deleteTargetProject?.openState === 'ready' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation">
          <button
            type="button"
            className="absolute inset-0 cursor-default border-none bg-transparent p-0"
            aria-label={t('project.cancel')}
            onClick={() => setDeleteTarget(null)}
          />
          <div
            className="relative z-10 bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-xl w-[400px] p-6 shadow-xl"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-semibold text-[var(--ink)]">{t('project.deleteTooltip')}</h2>
              <button
                type="button"
                className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--canvas-mid)] text-[var(--ink-tertiary)]"
                onClick={() => setDeleteTarget(null)}
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-[var(--ink-secondary)] text-[14px] leading-relaxed mb-6">
              {t('project.confirmDeleteMsg', { name: deleteTarget })}
              <br />
              {t('project.permanentDelete')}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary h-[34px] px-4" onClick={() => setDeleteTarget(null)}>
                {t('project.cancel')}
              </button>
              <button
                type="button"
                className="btn-primary h-[34px] px-4 !bg-red-600 !border-red-600 hover:!bg-red-700"
                onClick={handleDelete}
              >
                {t('project.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {migrationTarget && migrationPreflight && (
        <ManuscriptMigrationDialog
          project={migrationTarget}
          preflight={migrationPreflight}
          busy={migrationBusy}
          error={migrationError}
          onCancel={() => {
            if (migrationBusy) return
            void productionManuscriptMigration.cancel(migrationPreflight)
            setMigrationTarget(null)
            setMigrationPreflight(null)
            setMigrationError(null)
          }}
          onConfirm={() => void confirmMigration()}
        />
      )}
    </>
  )
}
