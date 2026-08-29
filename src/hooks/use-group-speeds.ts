import { useEffect, useState } from 'react'

import speedManager from '@/services/speed'

/**
 * 订阅一组分组的测速完成事件，返回 group → 完成次数 的版本表。
 * 与 useGroupsDelays 同理：身份仅在某个分组测速 settle 时变化，
 * 驱动 useRenderList 的分组缓存失效并按最新网速重排。
 */
export function useGroupSpeedVersions(
  groupNames: readonly string[],
): ReadonlyMap<string, number> {
  const [versions, setVersions] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  )

  useEffect(() => {
    const unsubscribers = groupNames.map((name) =>
      speedManager.addGroupListener(name, () => {
        setVersions((prev) => {
          const next = new Map(prev)
          next.set(name, (prev.get(name) ?? 0) + 1)
          return next
        })
      }),
    )
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [groupNames])

  return versions
}
