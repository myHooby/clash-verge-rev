import { beforeEach, describe, expect, test, vi } from 'vitest'

/** 捕获传给 cmds.startSpeedTest 的 onEvent 回调，用它在测试里模拟后端事件 */
const emitters: Array<(event: SpeedTestEvent) => void> = []

vi.mock('@/services/cmds', () => ({
  startSpeedTest: vi.fn(async () => null),
  stopSpeedTest: vi.fn(async () => undefined),
  getSpeedTestStatus: vi.fn(async () => ({
    running: false,
    total: 0,
    completed: 0,
    concurrency: 0,
  })),
}))

import { startSpeedTest, type SpeedTestEvent } from '@/services/cmds'

import speedManager, { SpeedManager, SpeedTestBusyError } from './speed'

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 每个用例从干净的 onEvent 队列开始；保留 .emit 形态以最小化用例改动 */
const latestChannel = () => {
  const emit = emitters[emitters.length - 1]
  return { emit: (message: SpeedTestEvent) => emit(message) }
}

const item = (
  name: string,
  ok: boolean,
  speed_bps = 0,
  error?: string,
): SpeedTestEvent => ({
  type: 'item',
  name,
  ok,
  speed_bps,
  // 生成的契约里 Option 序列化为 null
  error: error ?? null,
})

describe('SpeedManager', () => {
  beforeEach(() => {
    emitters.length = 0
    storage.clear()
    vi.stubGlobal('localStorage', localStorageStub)
    vi.mocked(startSpeedTest).mockClear()
    vi.mocked(startSpeedTest).mockImplementation(
      (
        _group: string,
        _names: string[],
        _concurrency: number,
        _url: string,
        onEvent,
      ) => {
        emitters.push(onEvent)
        return Promise.resolve(null)
      },
    )
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
    vi.mocked(startSpeedTest).mockRejectedValueOnce({
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

  test('finished results persist to localStorage and hydrate a fresh instance', async () => {
    const started = speedManager.startTest(
      'persist',
      ['p-ok', 'p-hang'],
      4,
      'https://example.com/down',
    )
    await flush()
    const channel = latestChannel()

    channel.emit(item('p-ok', true, 2_000_000))
    channel.emit({ type: 'done', total: 2, cancelled: false })
    await started

    // done 时立即落盘：已出结果的节点写入，仍处 testing 的节点被过滤
    const raw = JSON.parse(
      storage.get('verge-speed-results') ?? '{}',
    ) as Record<string, { value: { state: string } }>
    expect(raw['p-ok']?.value.state).toBe('ok')
    expect(raw['p-hang']).toBeUndefined()

    // 模拟 WebView 重载：新实例从 localStorage 恢复
    const fresh = new SpeedManager()
    expect(fresh.getSnapshot('p-ok')?.state).toBe('ok')
    expect(fresh.getSnapshot('p-hang')).toBeUndefined()
  })

  test('hydrated results stay visible beyond the old 30-minute TTL', () => {
    // 回归：此前读路径按 30 分钟 TTL 过期，放置一段时间后速度徽章凭空消失
    const aged = Date.now() - 45 * 60 * 1000
    storage.set(
      'verge-speed-results',
      JSON.stringify({
        old: {
          value: { state: 'ok', speedBps: 321_000, updatedAt: aged },
          updatedAt: aged,
        },
      }),
    )

    const fresh = new SpeedManager()
    expect(fresh.getSnapshot('old')).toMatchObject({
      state: 'ok',
      speedBps: 321_000,
    })
  })

  test('clearAll wipes cache, storage and notifies listeners', async () => {
    const started = speedManager.startTest(
      'clear',
      ['c1'],
      4,
      'https://example.com/down',
    )
    await flush()
    latestChannel().emit(item('c1', true, 500_000))
    latestChannel().emit({ type: 'done', total: 1, cancelled: false })
    await started
    expect(speedManager.getSpeedUpdate('c1')?.state).toBe('ok')

    let notified = 0
    const stop = speedManager.addGroupListener('clear', () => {
      notified += 1
    })
    let badgeNotifications = 0
    const stopBadge = speedManager.subscribeName('c1', () => {
      badgeNotifications += 1
    })

    speedManager.clearAll()
    await flush()

    expect(speedManager.getSpeedUpdate('c1')).toBeUndefined()
    expect(storage.has('verge-speed-results')).toBe(false)
    expect(notified).toBe(1)
    expect(badgeNotifications).toBe(1)
    stop()
    stopBadge()
  })
})
