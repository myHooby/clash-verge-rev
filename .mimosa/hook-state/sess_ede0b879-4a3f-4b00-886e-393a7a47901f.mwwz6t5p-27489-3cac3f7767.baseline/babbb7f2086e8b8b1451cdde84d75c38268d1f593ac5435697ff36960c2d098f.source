import { useCallback, useSyncExternalStore } from 'react'

import speedManager from '@/services/speed'

/** 单节点测速状态（未测返回 undefined，不渲染徽章） */
export function useSpeedState(name: string) {
  const subscribe = useCallback(
    (listener: () => void) => speedManager.subscribeName(name, listener),
    [name],
  )
  const getSnapshot = useCallback(() => speedManager.getSnapshot(name), [name])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 测速运行状态（对话框进度） */
export function useSpeedRunStatus() {
  const subscribe = useCallback(
    (listener: () => void) => speedManager.subscribeRun(listener),
    [],
  )
  const getSnapshot = useCallback(() => speedManager.getRunStatus(), [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
