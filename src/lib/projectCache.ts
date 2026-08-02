export function setProjectCacheValue<T>(cache: ReadonlyMap<string, T>, project: string, value: T): Map<string, T> {
  const next = new Map(cache)
  next.set(project, value)
  return next
}

/**
 * A project name is reusable after deletion, so it is not a stable cache key.
 * Do not manufacture an "unknown" key while metadata is still loading: that
 * would let two different incarnations share the same fallback value.
 */
export function projectInstanceCacheKey(project: string | null, instanceId?: string | null): string | null {
  if (!project || !instanceId) return null
  return JSON.stringify([project, instanceId])
}

/** Initialise a project's fallback without replacing its last successful value. */
export function initializeProjectCacheValue<T>(
  cache: ReadonlyMap<string, T>,
  project: string,
  fallback: T,
): Map<string, T> {
  if (cache.has(project)) return cache instanceof Map ? cache : new Map(cache)
  return setProjectCacheValue(cache, project, fallback)
}
