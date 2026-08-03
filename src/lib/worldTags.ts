function normalizeWorldTags(tags: readonly unknown[]): string[] {
  return [
    ...new Set(
      tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

export function parseWorldTags(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeWorldTags(value)
  if (typeof value !== 'string') return []

  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return normalizeWorldTags(parsed)
  } catch {
    // Legacy tag strings use either Chinese or ASCII commas.
  }

  return normalizeWorldTags(value.split(/[，,]/))
}

export function serializeWorldTags(tags: readonly string[]): string {
  return JSON.stringify(parseWorldTags(tags))
}
