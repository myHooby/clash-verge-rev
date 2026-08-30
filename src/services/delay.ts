import {
  delayProxyByName,
  healthcheckNodeInProvider,
  type ProxyDelay,
} from 'tauri-plugin-mihomo-api'

import {
  memberDetails,
  providerNameOf,
  type InteractableProxyMember,
  type ResolvedProxyMember,
} from '@/types/proxy-view'
import { debugLog } from '@/utils/debug'
import { classifyDelay, DEFAULT_DELAY_TIMEOUT } from '@/utils/delay'

import { clearResults, loadResults, saveResults } from './result-store'

export type DelaySnapshot = {
  of: (member: ResolvedProxyMember) => number
}

const hashKey = (name: string, group: string) => `${group ?? ''}::${name}`

export interface DelayUpdate {
  delay: number
  elapsed?: number
  updatedAt: number
}

/** 结果持久化键：WebView 重载后恢复；结果不按时间过期，直到新测试覆盖或 profile 变更清除 */
const STORAGE_KEY = 'verge-delay-results'
/** 防抖持久化间隔（批量测试时避免逐节点写 localStorage） */
const PERSIST_DEBOUNCE = 1200

const isPersistableDelay = (value: DelayUpdate) => value.delay !== -2

class DelayManager {
  private cache = new Map<string, DelayUpdate>()
  private urlMap = new Map<string, string>()

  private listenerMap = new Map<string, (update: DelayUpdate) => void>()

  private groupListenerMap = new Map<string, Set<() => void>>()
  // Consumers compare snapshot identity; replace it only when the group settles.
  private groupSnapshots = new Map<string, DelaySnapshot>()
  private groupSetSnapshots = new Map<
    string,
    ReadonlyMap<string, DelaySnapshot>
  >()
  // Suppress sort notifications until every measurement in a group batch settles.
  private activeBatches = new Map<string, number>()

  private pendingItemUpdates = new Map<string, DelayUpdate[]>()
  private pendingGroupUpdates = new Set<string>()
  private itemFlushScheduled = false
  private groupFlushScheduled = false

  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private eventsBound = false

  constructor() {
    // 从 localStorage 恢复上次会话的测速结果（WebView 重载后徽章与排序依据不丢）
    loadResults<DelayUpdate>(STORAGE_KEY, isPersistableDelay).forEach(
      (stored, key) => {
        this.cache.set(key, stored.value)
      },
    )
  }

  private schedulePersist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, PERSIST_DEBOUNCE)
  }

  /** 立即落盘（批量结束/应用退出前调用，防抖窗口内的结果不丢失） */
  private persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    saveResults(STORAGE_KEY, this.cache.entries(), isPersistableDelay)
  }

  /**
   * 订阅后端事件：切换/更新订阅（profile-changed）后旧结果作废，
   * 内存缓存与持久化一并清除并通知 UI 回到未测态。
   */
  bindEvents() {
    if (this.eventsBound) return
    this.eventsBound = true
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('profile-changed', () => this.clearAll()))
      .catch((error) => {
        console.error('[DelayManager] 绑定 profile-changed 事件失败', error)
        this.eventsBound = false
      })
  }

  /** 清空全部延迟结果（含持久化），并把已挂载的徽章重置为未测态 */
  clearAll() {
    this.cache.clear()
    clearResults(STORAGE_KEY)
    this.groupSnapshots.clear()
    this.groupSetSnapshots.clear()

    const untested: DelayUpdate = { delay: -1, updatedAt: Date.now() }
    for (const listener of this.listenerMap.values()) {
      try {
        listener(untested)
      } catch (error) {
        console.error('[DelayManager] 重置延迟徽章失败', error)
      }
    }
    for (const listeners of this.groupListenerMap.values()) {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[DelayManager] 通知分组重置失败', error)
        }
      }
    }
  }

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

      updates.forEach((queue, key) => {
        const listener = this.listenerMap.get(key)
        if (!listener) return

        queue.forEach((update) => {
          try {
            listener(update)
          } catch (error) {
            console.error(
              `[DelayManager] 通知节点延迟监听器失败: ${key}`,
              error,
            )
          }
        })
      })
    })
  }

  private scheduleGroupFlush() {
    if (this.groupFlushScheduled) return
    this.groupFlushScheduled = true

    this.scheduleOnNextFrame(() => {
      this.groupFlushScheduled = false
      const groups = this.pendingGroupUpdates
      this.pendingGroupUpdates = new Set()

      groups.forEach((group) => {
        const listeners = this.groupListenerMap.get(group)
        if (!listeners) return
        // Copied before iterating: a listener is free to unsubscribe as it runs.
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error(
              `[DelayManager] 通知分组延迟监听器失败: ${group}`,
              error,
            )
          }
        }
      })
    })
  }

  private queueGroupNotification(group: string) {
    if ((this.activeBatches.get(group) ?? 0) > 0) return
    // Invalidate the set wrapper while retaining unaffected per-group identities.
    this.groupSnapshots.delete(group)
    this.groupSetSnapshots.clear()
    this.pendingGroupUpdates.add(group)
    this.scheduleGroupFlush()
  }

  /** Cached set snapshot for `useSyncExternalStore` identity comparisons. */
  groupsDelays(groupKey: string): ReadonlyMap<string, DelaySnapshot> {
    const cached = this.groupSetSnapshots.get(groupKey)
    if (cached) return cached

    const names = groupKey ? groupKey.split(' ') : []
    const snapshots = new Map(
      names.map((name) => [name, this.groupDelays(name)]),
    )
    this.groupSetSnapshots.set(groupKey, snapshots)
    return snapshots
  }

  /** Cached group snapshot whose identity changes only when that group settles. */
  groupDelays(group: string): DelaySnapshot {
    const existing = this.groupSnapshots.get(group)
    if (existing) return existing

    const snapshot: DelaySnapshot = {
      of: (member) => this.getDelayFix(member, group),
    }
    this.groupSnapshots.set(group, snapshot)
    return snapshot
  }

  setUrl(group: string, url: string) {
    debugLog(`[DelayManager] 设置测试URL，组: ${group}, URL: ${url}`)
    this.urlMap.set(group, url)
  }

  getUrl(group: string) {
    const url = this.urlMap.get(group)
    debugLog(
      `[DelayManager] 获取测试URL，组: ${group}, URL: ${url || '未设置'}`,
    )
    return url || 'http://cp.cloudflare.com/generate_204'
  }

  setListener(
    name: string,
    group: string,
    listener: (update: DelayUpdate) => void,
  ) {
    const key = hashKey(name, group)
    this.listenerMap.set(key, listener)
  }

  removeListener(name: string, group: string) {
    const key = hashKey(name, group)
    this.listenerMap.delete(key)
  }

  /** Multiple views may subscribe independently; notifications occur only after settle. */
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

  setDelay(
    name: string,
    group: string,
    delay: number,
    meta?: { elapsed?: number },
  ): DelayUpdate {
    const key = hashKey(name, group)
    debugLog(
      `[DelayManager] 设置延迟，代理: ${name}, 组: ${group}, 延迟: ${delay}`,
    )
    const update: DelayUpdate = {
      delay,
      elapsed: meta?.elapsed,
      updatedAt: Date.now(),
    }

    this.cache.set(key, update)

    const queue = this.pendingItemUpdates.get(key)
    if (queue) {
      queue.push(update)
    } else {
      this.pendingItemUpdates.set(key, [update])
    }
    this.scheduleItemFlush()
    if (isPersistableDelay(update)) this.schedulePersist()

    return update
  }

  getDelayUpdate(name: string, group: string) {
    const key = hashKey(name, group)
    const entry = this.cache.get(key)
    if (!entry) return undefined

    // 不按时间过期：结果保留到新一轮测试覆盖或 profile 变更清除，
    // 避免放置一段时间后徽章/排序依据凭空消失。
    return { ...entry }
  }

  getDelay(name: string, group: string) {
    const update = this.getDelayUpdate(name, group)
    return update ? update.delay : -1
  }

  getDelayFix(member: ResolvedProxyMember, group: string) {
    if (member.kind === 'unresolved') return -1
    const details = memberDetails(member)
    const name = member.ref.name
    const update = this.getDelayUpdate(name, group)
    if (update && (update.delay >= 0 || update.delay === -2)) {
      return update.delay
    }

    if (details?.history && details.history.length > 0) {
      return details.history[details.history.length - 1].delay || 1e6
    }
    return -1
  }

  async unifiedDelayCheck(
    name: string,
    url: string,
    timeout: number,
    providerName?: string,
  ) {
    if (providerName)
      return healthcheckNodeInProvider(providerName, name, url, timeout)
    return delayProxyByName(name, url, timeout)
  }

  /** A single test may notify immediately; a batch defers notification until it settles. */
  async checkDelay(
    member: InteractableProxyMember,
    group: string,
    timeout: number,
  ): Promise<DelayUpdate> {
    const update = await this.measureDelay(member, group, timeout)
    this.queueGroupNotification(group)
    return update
  }

  private async measureDelay(
    member: InteractableProxyMember,
    group: string,
    timeout: number,
  ): Promise<DelayUpdate> {
    const name = member.ref.name
    const providerName =
      member.kind === 'node' ? providerNameOf(member.node) : undefined
    const apiName =
      member.kind === 'node' && member.node.source.kind === 'provider'
        ? member.node.source.proxyName
        : name
    debugLog(
      `[DelayManager] 开始测试延迟，代理: ${name}, 组: ${group}, 超时: ${timeout}ms`,
    )

    this.setDelay(name, group, -2)

    const startTime = Date.now()

    try {
      const url = this.getUrl(group)
      debugLog(`[DelayManager] 调用API测试延迟，代理: ${name}, URL: ${url}`)

      const timeoutPromise = new Promise<ProxyDelay>((resolve) => {
        setTimeout(() => resolve({ delay: 0 }), timeout)
      })

      const result = await Promise.race([
        this.unifiedDelayCheck(apiName, url, timeout, providerName),
        timeoutPromise,
      ])

      const elapsedTime = Date.now() - startTime
      if (elapsedTime < 500) {
        await new Promise((resolve) => setTimeout(resolve, 500 - elapsedTime))
      }

      const delay = result.delay
      const elapsed = elapsedTime
      debugLog(`[DelayManager] 延迟测试完成，代理: ${name}, 结果: ${delay}ms`)

      return this.setDelay(name, group, delay, { elapsed })
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      console.error(`[DelayManager] 延迟测试出错，代理: ${name}`, error)
      const delay = 1e6 // error
      const elapsed = Date.now() - startTime

      return this.setDelay(name, group, delay, { elapsed })
    }
  }

  async checkListDelay(
    proxies: InteractableProxyMember[],
    group: string,
    timeout: number,
    concurrency = 36,
  ) {
    debugLog(
      `[DelayManager] 批量测试延迟开始，组: ${group}, 数量: ${proxies.length}, 并发数: ${concurrency}`,
    )
    const names = proxies.map((member) => member.ref.name)
    this.activeBatches.set(group, (this.activeBatches.get(group) ?? 0) + 1)
    names.forEach((name) => {
      this.setDelay(name, group, -2)
    })

    let index = 0
    const startTime = Date.now()

    const help = async (): Promise<void> => {
      const currMember = proxies[index++]
      if (!currMember) return
      const currName = currMember.ref.name

      try {
        this.setDelay(currName, group, -2)

        // Stagger requests so a batch does not hit the core at once.
        if (index > 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 200),
          )
        }

        // Do not reorder a list around the pointer while batch results are arriving.
        await this.measureDelay(currMember, group, timeout)
      } catch (error) {
        console.error(
          `[DelayManager] 批量测试单个代理出错，代理: ${currName}`,
          error,
        )
        this.setDelay(currName, group, 1e6)
      }

      return help()
    }

    const actualConcurrency = Math.min(concurrency, names.length, 10)
    debugLog(`[DelayManager] 实际并发数: ${actualConcurrency}`)

    const promiseList: Promise<void>[] = []
    for (let i = 0; i < actualConcurrency; i++) {
      promiseList.push(help())
    }

    try {
      await Promise.all(promiseList)
    } finally {
      // Always release the batch and notify; otherwise failures leave stale sort state.
      const remaining = (this.activeBatches.get(group) ?? 1) - 1
      if (remaining > 0) {
        this.activeBatches.set(group, remaining)
      } else {
        this.activeBatches.delete(group)
        this.queueGroupNotification(group)
      }
      // 批量结束立即落盘，避免防抖窗口内退出应用丢失整批结果
      this.persistNow()
    }
    const totalTime = Date.now() - startTime
    debugLog(
      `[DelayManager] 批量测试延迟完成，组: ${group}, 总耗时: ${totalTime}ms`,
    )
  }

  formatDelay(delay: number, timeout = DEFAULT_DELAY_TIMEOUT) {
    switch (classifyDelay(delay, timeout)) {
      case 'untested':
        return '-'
      case 'testing':
        return 'testing'
      case 'timeout':
        return 'Timeout'
      case 'error':
        return 'Error'
      case 'measured':
        return `${delay}`
    }
  }

  formatDelayColor(delay: number, timeout = DEFAULT_DELAY_TIMEOUT) {
    switch (classifyDelay(delay, timeout)) {
      case 'untested':
      case 'testing':
        return ''
      case 'timeout':
      case 'error':
        return 'error.main'
      case 'measured':
        // Colour and signal bars intentionally use different grading thresholds.
        if (delay >= 400) return 'warning.main'
        if (delay >= 250) return 'primary.main'
        return 'success.main'
    }
  }
}

export default new DelayManager()
