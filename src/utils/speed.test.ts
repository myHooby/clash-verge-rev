import { describe, expect, test } from 'vitest'

import type { SpeedUpdate } from '@/services/speed'

import { classifySpeed, compareBySpeed, formatSpeed, speedColor } from './speed'

const MB = 1024 * 1024
const KB = 1024

const update = (state: SpeedUpdate['state'], speedBps = 0): SpeedUpdate => ({
  state,
  speedBps,
  updatedAt: Date.now(),
})

describe('formatSpeed', () => {
  test('renders human readable units', () => {
    expect(formatSpeed(500)).toBe('500 B/s')
    expect(formatSpeed(342_000)).toBe('334 KB/s')
    expect(formatSpeed(12.3 * MB)).toBe('12.3 MB/s')
    expect(formatSpeed(Number.NaN)).toBe('-')
    expect(formatSpeed(-1)).toBe('-')
  })
})

describe('classifySpeed', () => {
  test('tiers by thresholds and state', () => {
    expect(classifySpeed(undefined)).toBe('untested')
    expect(classifySpeed(update('testing'))).toBe('testing')
    expect(classifySpeed(update('fail'))).toBe('failed')
    expect(classifySpeed(update('ok', 12 * MB))).toBe('fast')
    expect(classifySpeed(update('ok', 2 * MB))).toBe('medium')
    expect(classifySpeed(update('ok', 500 * KB))).toBe('slow')
  })

  test('maps tiers to badge colors', () => {
    expect(speedColor('fast')).toBe('success.main')
    expect(speedColor('medium')).toBe('primary.main')
    expect(speedColor('slow')).toBe('warning.main')
    expect(speedColor('failed')).toBe('error.main')
    expect(speedColor('testing')).toBe('')
  })
})

describe('compareBySpeed', () => {
  test('orders measured desc, then failed, testing, untested', () => {
    const fast = update('ok', 10 * MB)
    const slow = update('ok', 300 * KB)
    const mid = update('ok', 2 * MB)
    const failed = update('fail')
    const testing = update('testing')

    const list = [failed, slow, testing, undefined, fast, mid].map((entry) => ({
      name: String(Math.random()),
      speed: entry,
    }))
    list.sort((a, b) => compareBySpeed(a.speed, b.speed))

    expect(list.map((item) => item.speed)).toEqual([
      fast,
      mid,
      slow,
      failed,
      testing,
      undefined,
    ])
  })

  test('equal tiers keep stable relative order', () => {
    const a = update('ok', 5 * MB)
    const b = update('ok', 5 * MB)
    expect(compareBySpeed(a, b)).toBe(0)
    expect(compareBySpeed(undefined, undefined)).toBe(0)
  })
})
