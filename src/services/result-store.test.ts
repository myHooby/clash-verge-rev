import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { clearResults, loadResults, saveResults } from './result-store'

const KEY = 'test-results'

const store = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
}

interface Entry {
  updatedAt: number
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', localStorageStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('result-store', () => {
  test('save then load round-trips values', () => {
    saveResults(KEY, [['a', { updatedAt: Date.now() }]])
    const loaded = loadResults<Entry>(KEY, () => true)
    expect(loaded.get('a')?.updatedAt).toBeGreaterThan(0)
  })

  test('entries survive regardless of age (no TTL eviction)', () => {
    // 回归：此前 30 分钟 TTL 会把放置一段时间的结果清掉，导致徽章凭空消失
    const stale = Date.now() - 25 * 60 * 60 * 1000
    saveResults(KEY, [
      ['fresh', { updatedAt: Date.now() }],
      ['stale', { updatedAt: stale }],
    ])

    const written = JSON.parse(store.get(KEY) ?? '{}') as Record<
      string,
      { updatedAt: number }
    >
    expect(written['stale']?.updatedAt).toBe(stale)

    const loaded = loadResults<Entry>(KEY, () => true)
    expect(loaded.has('fresh')).toBe(true)
    expect(loaded.get('stale')?.updatedAt).toBe(stale)
  })

  test('load applies the caller validity filter', () => {
    saveResults(KEY, [
      ['ok', { updatedAt: Date.now() }],
      ['testing', { updatedAt: Date.now() }],
    ])
    const loaded = loadResults<Entry>(KEY, (entry) => {
      // 模拟 speed 的 isValid：testing 态不恢复
      return !('transient' in entry)
    })
    expect(loaded.has('ok')).toBe(true)
  })

  test('save prunes invalid and malformed entries', () => {
    saveResults(KEY, [
      ['fresh', { updatedAt: Date.now() }],
      // 故意缺失 updatedAt 的脏数据（运行时应被跳过）
      ['broken', {} as Entry],
    ])
    const raw = JSON.parse(store.get(KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(['fresh'])
  })

  test('corrupt storage falls back to empty without throwing', () => {
    store.set(KEY, '{not-json')
    const loaded = loadResults<Entry>(KEY, () => true)
    expect(loaded.size).toBe(0)
  })

  test('clearResults removes the storage key', () => {
    saveResults(KEY, [['a', { updatedAt: Date.now() }]])
    clearResults(KEY)
    expect(store.has(KEY)).toBe(false)
    expect(loadResults<Entry>(KEY, () => true).size).toBe(0)
  })
})
