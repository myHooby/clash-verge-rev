/**
 * 测速/延迟结果的 localStorage 持久化助手。
 *
 * 结果原本只存在前端内存单例里，WebView 重载（macOS 内存压力回收渲染进程、
 * Vite 整页刷新等）后全部丢失。这里提供统一的 读/写/清 原语：
 * - 结果不按时间过期：保留到被新一轮测试覆盖，或 profile-changed 时整体清除
 *   （与 mihomo 自身延迟 history 的生命周期一致），仅过滤瞬时态（如 testing）
 * - 容错序列化失败（localStorage 不可用时静默跳过）
 */

export interface StoredResult<V> {
  value: V
  updatedAt: number
}

const hasLocalStorage = () =>
  typeof localStorage !== 'undefined' && localStorage !== null

/** 读取持久化结果：不合法条目剔除，任何异常回退为空表 */
export function loadResults<V>(
  key: string,
  isValid: (value: V) => boolean,
): Map<string, StoredResult<V>> {
  const result = new Map<string, StoredResult<V>>()
  if (!hasLocalStorage()) return result

  try {
    const raw = localStorage.getItem(key)
    if (!raw) return result

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return result

    for (const [name, entry] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!entry || typeof entry !== 'object') continue
      const { value, updatedAt } = entry as {
        value?: unknown
        updatedAt?: unknown
      }
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue
      if (value === undefined || value === null) continue
      if (!isValid(value as V)) continue
      result.set(name, { value: value as V, updatedAt })
    }
  } catch (error) {
    console.error(`[result-store] 读取 ${key} 失败`, error)
  }
  return result
}

/** 写入持久化结果：剔除不合法（如 testing 态）条目后整体覆盖，静默容错 */
export function saveResults<V extends { updatedAt: number }>(
  key: string,
  entries: Iterable<[string, V]>,
  isValid?: (value: V) => boolean,
): void {
  if (!hasLocalStorage()) return

  try {
    const payload: Record<string, { value: V; updatedAt: number }> = {}
    for (const [name, value] of entries) {
      if (!value || typeof value.updatedAt !== 'number') continue
      if (isValid && !isValid(value)) continue
      payload[name] = { value, updatedAt: value.updatedAt }
    }
    localStorage.setItem(key, JSON.stringify(payload))
  } catch (error) {
    console.error(`[result-store] 写入 ${key} 失败`, error)
  }
}

/** 清除持久化结果（静默容错） */
export function clearResults(key: string): void {
  if (!hasLocalStorage()) return
  try {
    localStorage.removeItem(key)
  } catch (error) {
    console.error(`[result-store] 清除 ${key} 失败`, error)
  }
}
