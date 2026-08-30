import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('tauri-plugin-mihomo-api', () => ({
  delayProxyByName: vi.fn(async () => ({ delay: 120 })),
  healthcheckNodeInProvider: vi.fn(async () => ({ delay: 120 })),
}))

import type { ResolvedProxyMember } from '@/types/proxy-view'

import delayManager from './delay'

const node = (name: string) =>
  ({
    kind: 'node',
    ref: { kind: 'node', name, recordId: `r:${name}` },
    node: {
      recordId: `r:${name}`,
      name,
      history: [],
      source: { kind: 'core', proxyName: name },
    },
  }) as unknown as ResolvedProxyMember

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let settles = 0
let unsubscribe: () => void

beforeEach(() => {
  settles = 0
  unsubscribe = delayManager.addGroupListener('g', () => {
    settles += 1
  })
})

afterEach(() => unsubscribe())

describe('group delay completion', () => {
  test('notifies once after a batch settles', async () => {
    const proxies = Array.from({ length: 6 }, (_, index) => node(`n${index}`))

    await delayManager.checkListDelay(proxies as never, 'g', 5000, 2)
    await flush()

    expect(settles).toBe(1)
  })

  test('notifies only listeners for the completed group', async () => {
    let other = 0
    const stop = delayManager.addGroupListener('other', () => {
      other += 1
    })

    await delayManager.checkDelay(node('a') as never, 'g', 5000)
    await flush()

    expect(settles).toBe(1)
    expect(other).toBe(0)
    stop()
  })

  test('clearAll resets every badge to untested and notifies groups', async () => {
    let groupNotifications = 0
    const stopGroup = delayManager.addGroupListener('g', () => {
      groupNotifications += 1
    })
    const received: number[] = []
    delayManager.setListener('z', 'g', (update) => {
      received.push(update.delay)
    })

    delayManager.setDelay('z', 'g', 42)
    await flush()
    expect(delayManager.getDelayUpdate('z', 'g')?.delay).toBe(42)
    const beforeClear = groupNotifications

    delayManager.clearAll()
    await flush()

    expect(delayManager.getDelayUpdate('z', 'g')).toBeUndefined()
    // 徽章监听器收到"未测"重置值，分组监听器收到 settle 通知
    expect(received[received.length - 1]).toBe(-1)
    expect(groupNotifications).toBe(beforeClear + 1)
    stopGroup()
  })
})
