import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { clearResults, loadResults, saveResults } from './result-store'

const KEY = 'test-results'
const TTL = 30 * 60 * 1000

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
    saveResults(KEY, [['a', { updatedAt: Date.now() }]], TTL)
    const loaded = loadResults<Entry>(KEY, TTL, () => true)
    expect(loaded.get('a')?.updatedAt).toBeGreaterThan(0)
  })

  test('load prunes expired entries', () => {
    saveResults(
      KEY,
      [
        ['fresh', { updatedAt: Date.now() }],
        ['stale', { updatedAt: Date.now() - TTL - 1 }],
      ],
      TTL,
    )
    const loaded = loadResults<Entry>(KEY, TTL, () => true)
    expect(loaded.has('fresh')).toBe(true)
    expect(loaded.has('stale')).toBe(false)
  })

  test('load applies the caller validity filter', () => {
    saveResults(
      KEY,
      [
        ['ok', { updatedAt: Date.now() }],
        ['testing', { updatedAt: Date.now() }],
      ],
      TTL,
    )
    const loaded = loadResults<Entry>(KEY, TTL, (entry) => {
      // 模拟 speed 的 isValid：testing 态不恢复
      return !('transient' in entry)
    })
    expect(loaded.has('ok')).toBe(true)
  })

  test('save itself prunes expired and invalid entries', () => {
    saveResults(
      KEY,
      [
        ['fresh', { updatedAt: Date.now() }],
        ['stale', { updatedAt: Date.now() - TTL - 1 }],
        // 故意缺失 updatedAt 的脏数据（运行时应被跳过）
        ['broken', {} as Entry],
      ],
      TTL,
    )
    const raw = JSON.parse(store.get(KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(['fresh'])
  })

  test('corrupt storage falls back to empty without throwing', () => {
    store.set(KEY, '{not-json')
    const loaded = loadResults<Entry>(KEY, TTL, () => true)
    expect(loaded.size).toBe(0)
  })

  test('clearResults removes the storage key', () => {
    saveResults(KEY, [['a', { updatedAt: Date.now() }]], TTL)
    clearResults(KEY)
    expect(store.has(KEY)).toBe(false)
    expect(loadResults<Entry>(KEY, TTL, () => true).size).toBe(0)
  })
})
