/**
 * 按节点测速状态管理（仿 DelayManager 模式）：
 * - 节点速度全局按节点名缓存（与延迟不同，速度与分组无关）
 * - 批量测速期间抑制分组排序通知，整轮结束后一次性刷新
 * - 通过 Tauri Channel 接收 Rust 侧增量事件
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { debugLog } from '@/utils/debug'

export type SpeedState = 'testing' | 'ok' | 'fail'

export interface SpeedUpdate {
  state: SpeedState
  speedBps: number
  error?: string
  updatedAt: number
}

export interface SpeedRunStatus {
  running: boolean
  group?: string
  total: number
  completed: number
  concurrency: number
}

/** Rust SpeedTestEvent 的序列化形态 */
type SpeedTestEvent =
  | {
      type: 'item'
      name: string
      ok: boolean
      speed_bps: number
      error?: string
    }
  | { type: 'done'; total: number; cancelled: boolean }

const CACHE_TTL = 30 * 60 * 1000

/** 并发档位（需求：4/8/16 可选） */
export const SPEED_CONCURRENCY_OPTIONS = [4, 8, 16] as const
/** 默认测速文件：Cloudflare 25MB 下发端点，与后端单节点采样上限对齐 */
export const DEFAULT_SPEED_TEST_URL =
  'https://speed.cloudflare.com/__down?bytes=25000000'

const CONCURRENCY_STORAGE_KEY = 'speed-test-concurrency'
const URL_STORAGE_KEY = 'speed-test-url'

export interface SpeedTestOptions {
  concurrency: number
  url: string
}

/** 读取持久化的测速参数（对话框与单节点重测共用） */
export function getStoredSpeedTestOptions(): SpeedTestOptions {
  const saved = Number(localStorage.getItem(CONCURRENCY_STORAGE_KEY))
  const concurrency = (SPEED_CONCURRENCY_OPTIONS as readonly number[]).includes(
    saved,
  )
    ? saved
    : SPEED_CONCURRENCY_OPTIONS[0]
  const url =
    localStorage.getItem(URL_STORAGE_KEY)?.trim() || DEFAULT_SPEED_TEST_URL
  return { concurrency, url }
}

export function storeSpeedTestOptions(options: SpeedTestOptions): void {
  localStorage.setItem(CONCURRENCY_STORAGE_KEY, String(options.concurrency))
  localStorage.setItem(URL_STORAGE_KEY, options.url)
}

const IDLE_STATUS: SpeedRunStatus = Object.freeze({
  running: false,
  total: 0,
  completed: 0,
  concurrency: 0,
})

export class SpeedTestBusyError extends Error {
  constructor() {
    super('speed test already running')
    this.name = 'SpeedTestBusyError'
  }
}

class SpeedManager {
  private cache = new Map<string, SpeedUpdate>()
  private listenerMap = new Map<string, (update: SpeedUpdate) => void>()
  private runListeners = new Set<() => void>()
  private groupListenerMap = new Map<string, Set<() => void>>()

  private pendingItemUpdates = new Map<string, SpeedUpdate>()
  private pendingRunNotify = false
  private itemFlushScheduled = false

  private status: SpeedRunStatus = IDLE_STATUS
  /** 进行中的测速所属分组；批量期间抑制该分组的排序通知 */
  private activeGroup: string | null = null
  /** 本轮待测节点名：done(cancelled) 时把仍处于 testing 的节点收尾 */
  private runNames = new Set<string>()

  private scheduleOnNextFrame(run: () => void): void {
    if (typeof window !== 'undefined') {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run)
        return
      }
      if (typeof window.setTimeout === 'function') {
        window.setTimeout(run, 0)
        return
      }
    }
    Promise.resolve().then(run)
  }

  private scheduleItemFlush() {
    if (this.itemFlushScheduled) return
    this.itemFlushScheduled = true

    this.scheduleOnNextFrame(() => {
      this.itemFlushScheduled = false
      const updates = this.pendingItemUpdates
      this.pendingItemUpdates = new Map()

      updates.forEach((update, key) => {
        const listener = this.listenerMap.get(key)
        if (!listener) return
        try {
          listener(update)
        } catch (error) {
          console.error(`[SpeedManager] 通知节点速度监听器失败: ${key}`, error)
        }
      })
    })
  }

  private notifyRunListeners() {
    if (this.pendingRunNotify) return
    this.pendingRunNotify = true

    this.scheduleOnNextFrame(() => {
      this.pendingRunNotify = false
      for (const listener of [...this.runListeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[SpeedManager] 通知运行状态监听器失败', error)
        }
      }
    })
  }

  /** 分组排序通知：批量进行中抑制，结束后一次性触发 */
  private notifyGroupSettled(group: string | null) {
    if (!group) return
    const listeners = this.groupListenerMap.get(group)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error(`[SpeedManager] 通知分组监听器失败: ${group}`, error)
      }
    }
  }

  addGroupListener(group: string, listener: () => void): () => void {
    const listeners = this.groupListenerMap.get(group) ?? new Set()
    listeners.add(listener)
    this.groupListenerMap.set(group, listeners)

    return () => {
      const current = this.groupListenerMap.get(group)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.groupListenerMap.delete(group)
    }
  }

  /** 单节点徽章订阅（useSyncExternalStore） */
  subscribeName(
    name: string,
    listener: (update: SpeedUpdate) => void,
  ): () => void {
    this.listenerMap.set(name, listener)
    return () => {
      this.listenerMap.delete(name)
    }
  }

  /** 对话框运行状态订阅（useSyncExternalStore） */
  subscribeRun(listener: () => void): () => void {
    this.runListeners.add(listener)
    return () => {
      this.runListeners.delete(listener)
    }
  }

  getSnapshot(name: string): SpeedUpdate | undefined {
    const entry = this.cache.get(name)
    if (!entry) return undefined

    if (Date.now() - entry.updatedAt > CACHE_TTL) {
      this.cache.delete(name)
      return undefined
    }
    return entry
  }

  /** 兼容排序读取：返回缓存更新（含 TTL 清理） */
  getSpeedUpdate(name: string): SpeedUpdate | undefined {
    return this.getSnapshot(name)
  }

  getRunStatus(): SpeedRunStatus {
    return this.status
  }

  setSpeed(
    name: string,
    state: SpeedState,
    speedBps = 0,
    error?: string,
  ): SpeedUpdate {
    const update: SpeedUpdate = {
      state,
      speedBps,
      error,
      updatedAt: Date.now(),
    }
    this.cache.set(name, update)

    this.pendingItemUpdates.set(name, update)
    this.scheduleItemFlush()
    return update
  }

  /** 整轮结束后刷新进度快照身份（completed/total 变化驱动对话框渲染） */
  private setStatus(status: SpeedRunStatus) {
    this.status = Object.freeze(status)
    this.notifyRunListeners()
  }

  /**
   * 启动一轮组内测速。事件到达即更新节点状态；invoke 返回只代表
   * "任务已受理"，真正的完成以 done 事件为准。
   */
  async startTest(
    group: string,
    names: string[],
    concurrency: number,
    url: string,
  ): Promise<void> {
    if (this.status.running) throw new SpeedTestBusyError()

    const uniqueNames = [...new Set(names.filter((name) => name))]
    if (uniqueNames.length === 0) return

    this.activeGroup = group
    this.runNames = new Set(uniqueNames)
    this.setStatus({
      running: true,
      group,
      total: uniqueNames.length,
      completed: 0,
      concurrency,
    })
    uniqueNames.forEach((name) => this.setSpeed(name, 'testing'))

    const finishRun = (total: number, cancelled: boolean) => {
      if (cancelled) {
        this.runNames.forEach((name) => {
          if (this.cache.get(name)?.state === 'testing') {
            this.setSpeed(name, 'fail', 0, 'cancelled')
          }
        })
      }
      this.runNames.clear()
      const settledGroup = this.activeGroup
      this.activeGroup = null
      this.setStatus({
        running: false,
        group: undefined,
        total,
        completed: total,
        concurrency: this.status.concurrency,
      })
      this.notifyGroupSettled(settledGroup)
    }

    const channel = new Channel<SpeedTestEvent>((event) => {
      if (event.type === 'item') {
        this.setSpeed(
          event.name,
          event.ok ? 'ok' : 'fail',
          event.speed_bps,
          event.error,
        )
        const current = this.status
        if (current.running) {
          this.setStatus({ ...current, completed: current.completed + 1 })
        }
        return
      }

      // done：整轮结束（完成或取消），解除批量抑制并通知排序刷新
      debugLog(
        `[SpeedManager] 测速结束，总数: ${event.total}, 取消: ${event.cancelled}`,
      )
      finishRun(event.total, event.cancelled)
    })

    try {
      await invoke('start_speed_test', {
        group,
        names: uniqueNames,
        concurrency,
        url,
        onEvent: channel,
      })
    } catch (error) {
      // 后端拒绝（busy/参数/监听器应用失败）：本轮作废，未完成节点标记失败
      const busy =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'speed-test/busy'
      const message =
        error && typeof error === 'object' && 'detail' in error
          ? String((error as { detail?: unknown }).detail)
          : String(error)

      this.runNames.forEach((name) => {
        if (this.cache.get(name)?.state === 'testing') {
          this.setSpeed(name, 'fail', 0, message)
        }
      })
      this.runNames.clear()
      const failedGroup = this.activeGroup
      this.activeGroup = null
      this.setStatus({
        running: false,
        total: uniqueNames.length,
        completed: uniqueNames.length,
        concurrency,
      })
      this.notifyGroupSettled(failedGroup)

      if (busy) throw new SpeedTestBusyError()
    }
  }

  async stopTest(): Promise<void> {
    await invoke('stop_speed_test')
  }

  /** 对话框重开时同步后端真实状态（应用重启/页面刷新后恢复进度） */
  async refreshStatus(): Promise<void> {
    try {
      const status = await invoke<SpeedRunStatus>('get_speed_test_status')
      const normalized: SpeedRunStatus = {
        running: status?.running ?? false,
        group: status?.group,
        total: status?.total ?? 0,
        completed: status?.completed ?? 0,
        concurrency: status?.concurrency ?? 0,
      }
      if (
        normalized.running !== this.status.running ||
        normalized.completed !== this.status.completed ||
        normalized.total !== this.status.total
      ) {
        this.activeGroup = normalized.running
          ? (normalized.group ?? null)
          : null
        this.setStatus(normalized)
      }
    } catch (error) {
      console.error('[SpeedManager] 查询测速状态失败', error)
    }
  }

  /**
   * 订阅配置变更事件：订阅切换/配置重载会覆盖注入的测速监听器，
   * 主动停止测速让后端尽快恢复原配置。
   */
  async bindConfigWatch(): Promise<void> {
    const stopIfRunning = () => {
      if (this.status.running) {
        debugLog('[SpeedManager] 配置变更，自动停止测速')
        void this.stopTest()
      }
    }
    try {
      await listen('verge://refresh-clash-config', stopIfRunning)
      await listen('profile-changed', stopIfRunning)
    } catch (error) {
      console.error('[SpeedManager] 绑定配置变更事件失败', error)
    }
  }
}

export default new SpeedManager()
