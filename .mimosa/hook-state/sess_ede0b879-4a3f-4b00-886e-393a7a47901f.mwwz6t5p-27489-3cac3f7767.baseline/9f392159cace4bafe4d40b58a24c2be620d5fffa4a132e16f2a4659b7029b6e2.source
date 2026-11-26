/** 测速结果的展示与排序工具（纯函数，便于单测） */

import type { SpeedUpdate } from '@/services/speed'

const KB = 1024
const MB = 1024 * 1024

/** 速度档位：决定徽章配色与排序分组 */
export type SpeedTier =
  | 'fast'
  | 'medium'
  | 'slow'
  | 'failed'
  | 'testing'
  | 'untested'

const FAST_BPS = 10 * MB
const MEDIUM_BPS = 1 * MB

export const classifySpeed = (update: SpeedUpdate | undefined): SpeedTier => {
  if (!update) return 'untested'
  switch (update.state) {
    case 'testing':
      return 'testing'
    case 'fail':
      return 'failed'
    case 'ok':
      if (update.speedBps >= FAST_BPS) return 'fast'
      if (update.speedBps >= MEDIUM_BPS) return 'medium'
      return 'slow'
  }
}

/** 字节/秒 → 人类可读速度（B/s、KB/s、MB/s） */
export const formatSpeed = (speedBps: number): string => {
  if (!Number.isFinite(speedBps) || speedBps < 0) return '-'
  if (speedBps >= MB) return `${(speedBps / MB).toFixed(1)} MB/s`
  if (speedBps >= KB) return `${(speedBps / KB).toFixed(0)} KB/s`
  return `${Math.round(speedBps)} B/s`
}

/** 徽章配色：档位→MUI 色板 */
export const speedColor = (tier: SpeedTier): string => {
  switch (tier) {
    case 'fast':
      return 'success.main'
    case 'medium':
      return 'primary.main'
    case 'slow':
      return 'warning.main'
    case 'failed':
      return 'error.main'
    case 'testing':
    case 'untested':
      return ''
  }
}

/** 排序权重：实测降序 → 失败 → 测试中 → 未测（数组 sort 稳定，无需 tie-breaker） */
const rankOf = (tier: SpeedTier): number => {
  switch (tier) {
    case 'fast':
    case 'medium':
    case 'slow':
      return 0
    case 'failed':
      return 1
    case 'testing':
      return 2
    case 'untested':
      return 3
  }
}

export const compareBySpeed = (
  a: SpeedUpdate | undefined,
  b: SpeedUpdate | undefined,
): number => {
  const [aTier, bTier] = [classifySpeed(a), classifySpeed(b)]
  const rankDifference = rankOf(aTier) - rankOf(bTier)
  if (rankDifference !== 0) return rankDifference

  if (aTier !== 'fast' && aTier !== 'medium' && aTier !== 'slow') return 0
  return (b?.speedBps ?? 0) - (a?.speedBps ?? 0)
}
