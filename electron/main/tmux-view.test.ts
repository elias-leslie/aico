import { describe, expect, it, vi } from 'vitest'
import {
  coalesceAsync,
  coalesceTrailingAsync,
  paneModeArgs,
  parsePaneMode,
  refreshAttachedClients,
} from './tmux-view'

const attached = { socket: '/s/server.sock', target: '$3' }

describe('coalescing', () => {
  it('shares one pending load and starts a fresh one afterwards', async () => {
    const load = vi.fn(async () => 1)
    const run = coalesceAsync(load)
    await Promise.all([run(), run()])
    await run()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('repeats trailing work once for signals that arrive while it runs', async () => {
    let release = (): void => {}
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const run = coalesceTrailingAsync(work)
    const first = run()
    run()
    run()
    release()
    await Promise.resolve()
    await Promise.resolve()
    release()
    await first
    expect(work).toHaveBeenCalledTimes(2)
  })
})

describe('read-only view queries', () => {
  it('asks the attached target for its pane mode', () => {
    expect(paneModeArgs(attached)).toEqual([
      '-S',
      '/s/server.sock',
      'display-message',
      '-p',
      '-t',
      '$3',
      '#{?alternate_on,1,0} #{?mouse_any_flag,1,0} #{history_size}',
    ])
    expect(parsePaneMode('1 0 4200\n')).toEqual({
      alternateScreen: true,
      mouseReporting: false,
      historySize: 4200,
    })
    expect(parsePaneMode('')).toEqual({
      alternateScreen: false,
      mouseReporting: false,
      historySize: 0,
    })
  })

  it('repaints only this session’s clients and stops once stale', async () => {
    const calls: string[][] = []
    let current = true
    await refreshAttachedClients(
      attached,
      async (args) => {
        calls.push(args)
        if (args.includes('refresh-client')) current = false
        return '/dev/pts/1\n/dev/pts/2\n'
      },
      () => current,
    )
    expect(calls).toEqual([
      ['-S', '/s/server.sock', 'list-clients', '-t', '$3', '-F', '#{client_name}'],
      ['-S', '/s/server.sock', 'refresh-client', '-t', '/dev/pts/1'],
    ])
  })
})
