import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'

type Emit = (message: unknown) => void

const channels: { emit: Emit }[] = []

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    private handler?: Emit
    constructor(handler?: Emit) {
      this.handler = handler
      channels.push({ emit: (message) => this.handler?.(message) })
    }
  },
  invoke: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

import speedManager, { SpeedTestBusyError } from './speed'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 每个用例从干净的 Channel 队列开始 */
const latestChannel = () => channels[channels.length - 1]

const item = (name: string, ok: boolean, speed_bps = 0, error?: string) => ({
  type: 'item',
  name,
  ok,
  speed_bps,
  error,
})

describe('SpeedManager', () => {
  beforeEach(() => {
    channels.length = 0
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  test('batch lifecycle: testing → per-item updates → single settle notification', async () => {
    let settles = 0
    const stop = speedManager.addGroupListener('g', () => {
      settles += 1
    })

    const started = speedManager.startTest(
      'g',
      ['a', 'b', 'c'],
      4,
      'https://example.com/down',
    )
    await flush()
    const channel = latestChannel()

    // 受理后全部进入 testing，运行状态生效
    expect(speedManager.getSpeedUpdate('a')?.state).toBe('testing')
    expect(speedManager.getSpeedUpdate('b')?.state).toBe('testing')
    expect(speedManager.getRunStatus()).toMatchObject({
      running: true,
      group: 'g',
      total: 3,
      completed: 0,
      concurrency: 4,
    })

    channel.emit(item('a', true, 1_500_000))
    channel.emit(item('b', false, 0, 'request failed'))
    await flush()

    expect(speedManager.getSpeedUpdate('a')).toMatchObject({
      state: 'ok',
      speedBps: 1_500_000,
    })
    expect(speedManager.getSpeedUpdate('b')).toMatchObject({
      state: 'fail',
      error: 'request failed',
    })
    expect(speedManager.getRunStatus().completed).toBe(2)
    // 批量进行中不触发分组通知
    expect(settles).toBe(0)

    channel.emit(item('c', true, 500_000))
    channel.emit({ type: 'done', total: 3, cancelled: false })
    await started
    await flush()

    expect(speedManager.getRunStatus()).toMatchObject({
      running: false,
      total: 3,
      completed: 3,
    })
    expect(speedManager.getSpeedUpdate('c')?.state).toBe('ok')
    expect(settles).toBe(1)

    stop()
  })

  test('cancelled run marks remaining testing nodes as failed', async () => {
    const started = speedManager.startTest(
      'g',
      ['x', 'y'],
      8,
      'https://example.com/down',
    )
    await flush()
    const channel = latestChannel()

    channel.emit(item('x', true, 800_000))
    channel.emit({ type: 'done', total: 2, cancelled: true })
    await started
    await flush()

    expect(speedManager.getSpeedUpdate('x')?.state).toBe('ok')
    expect(speedManager.getSpeedUpdate('y')).toMatchObject({
      state: 'fail',
      error: 'cancelled',
    })
    expect(speedManager.getRunStatus().running).toBe(false)
  })

  test('backend rejection fails pending nodes and surfaces busy code', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      code: 'speed-test/busy',
      detail: 'speed test already running',
    })

    await expect(
      speedManager.startTest('g', ['a', 'b'], 4, 'https://example.com/down'),
    ).rejects.toBeInstanceOf(SpeedTestBusyError)
    await flush()

    expect(speedManager.getSpeedUpdate('a')?.state).toBe('fail')
    expect(speedManager.getSpeedUpdate('b')?.state).toBe('fail')
    expect(speedManager.getRunStatus().running).toBe(false)
  })

  test('manager guard rejects a second run while one is active', async () => {
    const first = speedManager.startTest(
      'g',
      ['a'],
      4,
      'https://example.com/down',
    )
    await flush()

    await expect(
      speedManager.startTest('g', ['b'], 4, 'https://example.com/down'),
    ).rejects.toBeInstanceOf(SpeedTestBusyError)

    latestChannel().emit({ type: 'done', total: 1, cancelled: false })
    await first
  })
})
