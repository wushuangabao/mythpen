// Auto-refresh hook — subscribe to data change events and re-fetch.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type EntityType, onDataChanged, refreshAllData } from '@/lib/dataEvents'

/**
 * Subscribe to data change events for a specific entity type.
 * When a matching `notifyDataChanged(entity)` fires, `refresher` is called.
 *
 * Also returns a `refresh` function that can be called manually to trigger a full refresh.
 *
 * @example
 * // Auto-refresh when AI modifies data + manual refresh button
 * function CharacterList() {
 *   const { data, loading, reload } = useCharacters()
 *   const { refresh, refreshing } = useDataRefresh('character', reload)
 *   return (
 *     <div>
 *       <button onClick={refresh} disabled={refreshing}>
 *         {refreshing ? '刷新中...' : '↻ 刷新'}
 *       </button>
 *       ...
 *     </div>
 *   )
 * }
 */
export function useDataRefresh(
  entity: EntityType | EntityType[],
  refresher: () => void,
  _deps: React.DependencyList = [],
): { refresh: () => void; refreshing: boolean } {
  const refresherRef = useRef(refresher)
  refresherRef.current = refresher

  const [refreshing, setRefreshing] = useState(false)
  const entityKey = Array.isArray(entity) ? entity.join(',') : entity
  const entities = useMemo(() => new Set(entityKey.split(',') as EntityType[]), [entityKey])

  // Auto-subscribe to data change events
  useEffect(() => {
    const unsub = onDataChanged((event) => {
      if (event.entity === 'all' || entities.has(event.entity)) {
        refresherRef.current()
      }
    })
    return unsub
  }, [entities])

  // Manual refresh trigger
  const refresh = useCallback(() => {
    setRefreshing(true)
    refreshAllData().finally(() => setRefreshing(false))
  }, [])

  return { refresh, refreshing }
}
