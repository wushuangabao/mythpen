export function shouldShowWorldInitialLoading(loading: boolean, hasEntries: boolean): boolean {
  return loading && !hasEntries
}
