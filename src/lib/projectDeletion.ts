export interface NamedProject {
  name: string
}

export interface ProjectDeletionTransition<TProject extends NamedProject> {
  projects: TProject[]
  currentProject: string | null
  deletedCurrentProject: boolean
}

/**
 * Remove a successfully deleted project from the last usable local snapshot.
 * This transition is synchronous so a failed follow-up list refresh cannot
 * reactivate the deleted name.
 */
export function removeDeletedProject<TProject extends NamedProject>(
  projects: readonly TProject[],
  currentProject: string | null,
  deletedProject: string,
): ProjectDeletionTransition<TProject> {
  const remainingProjects = projects.filter((project) => project.name !== deletedProject)
  const deletedCurrentProject = currentProject === deletedProject
  return {
    projects: remainingProjects,
    currentProject: deletedCurrentProject ? remainingProjects[0]?.name || null : currentProject,
    deletedCurrentProject,
  }
}
