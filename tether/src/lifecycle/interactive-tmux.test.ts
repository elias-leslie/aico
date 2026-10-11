import { describe, expect, it, vi } from 'vitest'
import {
  activateTmuxViewSize,
  coalesceAsync,
  coalesceTrailingAsync,
  refreshAttachedTmuxClients,
} from './interactive-tmux'
import {
  listClientsTargetArgs,
  listWindowIdsArgs,
  refreshClientArgs,
  resizeWindowArgs,
  sessionStatusArgs,
  type TmuxTarget,
} from './tmux'

const target: TmuxTarget = { socket: '/tmp/tmux-1000/aico', session: 'aico-widget' }

describe('interactive tmux work', () => {
  it('replays a resize requested while a previous fit is running', async () => {
    let releaseFirst: () => void = () => {}
    const work = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockResolvedValue(undefined)
    const request = coalesceTrailingAsync(work)
    const first = request()
    expect(request()).toBe(first)
    expect(work).toHaveBeenCalledTimes(1)
    releaseFirst()
    await first
    expect(work).toHaveBeenCalledTimes(2)
    await request()
    expect(work).toHaveBeenCalledTimes(3)
  })

  it('sizes the active client with another client on the same window', async () => {
    const clientArgs = listClientsTargetArgs(target, '#{client_pid}\t#{window_id}')
    const run = vi.fn(async (args: string[]) => {
      if (JSON.stringify(args) === JSON.stringify(clientArgs)) return '432\t@7\n999\t@7\n'
      if (JSON.stringify(args) === JSON.stringify(listWindowIdsArgs(target.socket)))
        return '@7\n@8\n'
      if (JSON.stringify(args) === JSON.stringify(sessionStatusArgs(target))) return 'off\n'
      return ''
    })
    expect(await activateTmuxViewSize(target, 432, 101, 79, run, () => true)).toBe(true)
    expect(run.mock.calls.at(-1)?.[0]).toEqual(resizeWindowArgs('@7', target.socket, 101, 79))
  })

  it('does not size a linked window or stale attachment', async () => {
    const run = vi.fn().mockResolvedValueOnce('432\t@7\n').mockResolvedValueOnce('@7\n@7\n')
    expect(await activateTmuxViewSize(target, 432, 101, 79, run, () => true)).toBe(false)
    expect(run).toHaveBeenCalledTimes(2)
    run
      .mockReset()
      .mockResolvedValueOnce('432\t@7\n')
      .mockResolvedValueOnce('@7\n')
      .mockResolvedValueOnce('off\n')
      .mockResolvedValueOnce('999\t@7\n')
    expect(await activateTmuxViewSize(target, 432, 101, 79, run, () => true)).toBe(false)
    expect(run).toHaveBeenCalledTimes(4)
    run
      .mockReset()
      .mockResolvedValueOnce('432\t@7\n')
      .mockResolvedValueOnce('@7\n')
      .mockResolvedValueOnce('on\n')
    expect(await activateTmuxViewSize(target, 432, 101, 79, run, () => true)).toBe(false)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('coalesces overlapping catalog queries and retries after completion', async () => {
    let resolveFirst: (value: string[]) => void = () => {}
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(['new'])
    const request = coalesceAsync(load)

    const first = request()
    const overlap = request()
    expect(first).toBe(overlap)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    resolveFirst(['old'])
    expect(await first).toEqual(['old'])
    expect(await request()).toEqual(['new'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('releases a failed catalog query so the next request can retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce([])
    const request = coalesceAsync(load)
    await expect(request()).rejects.toThrow('timeout')
    await expect(request()).resolves.toEqual([])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('refreshes each client from the exact selected socket and session', async () => {
    const run = vi.fn(async (args: string[]) =>
      args[2] === 'list-clients' ? '/dev/pts/1\n\n/dev/pts/2\n' : '',
    )
    await refreshAttachedTmuxClients(target, run, () => true)
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      listClientsTargetArgs(target),
      refreshClientArgs('/dev/pts/1', target.socket),
      refreshClientArgs('/dev/pts/2', target.socket),
    ])
  })

  it('treats an empty client list as a no-op', async () => {
    const run = vi.fn().mockResolvedValueOnce('\n')
    await refreshAttachedTmuxClients(target, run, () => true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(listClientsTargetArgs(target))
  })

  it('stops before repaint when the initiating PTY changes during listing', async () => {
    let current = true
    const run = vi.fn(async () => {
      current = false
      return '/dev/pts/1\n'
    })
    await refreshAttachedTmuxClients(target, run, () => current)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stops between clients when the initiating PTY changes during repaint', async () => {
    let current = true
    const run = vi.fn(async (args: string[]) => {
      if (args[2] === 'list-clients') return '/dev/pts/1\n/dev/pts/2\n'
      current = false
      return ''
    })
    await refreshAttachedTmuxClients(target, run, () => current)
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      listClientsTargetArgs(target),
      refreshClientArgs('/dev/pts/1', target.socket),
    ])
  })

  it('propagates query and repaint failures to the caller', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('/dev/pts/1\n')
      .mockRejectedValueOnce(new Error('timeout'))
    await expect(refreshAttachedTmuxClients(target, run, () => true)).rejects.toThrow('timeout')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
