import { describe, expect, it, vi } from 'vitest'
import { LifecycleOwnerLock } from './lifecycle-guard'
import {
  createSelectionDeliveryLease,
  deliverSelectionToPane,
  resolveActiveSelectionPane,
  type SelectionDeliveryLease,
} from './selection-delivery'
import { sendTextTargetArgs, type TmuxTarget } from './tmux'

const pane: TmuxTarget = { socket: '/tmp/tmux-1000/aico', session: '%7' }
const record = { kind: 'Link', snippet: 'example', meta: { url: 'https://example.test' } }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(target: TmuxTarget | Promise<TmuxTarget> = pane) {
  const owners = new LifecycleOwnerLock()
  let generation = 1
  let window = 1
  const delivered = vi.fn()
  const failed = vi.fn()
  const acquire = (): SelectionDeliveryLease | null => {
    const owner = owners.acquire('widget')
    if (!owner) return null
    const selectedGeneration = generation
    const selectedWindow = window
    return {
      target,
      isCurrent: () => generation === selectedGeneration && window === selectedWindow,
      delivered,
      release: () => {
        owners.release(owner)
      },
    }
  }
  return {
    owners,
    acquire,
    delivered,
    failed,
    replace: () => {
      generation += 1
    },
    reopen: () => {
      window += 1
    },
  }
}

describe('selection delivery lifecycle', () => {
  it('resolves the active pane in a multi-pane external session and pins the send to it', async () => {
    const session: TmuxTarget = { socket: null, session: 'summitflow-abc' }
    const query = vi.fn(async () => '%42\n')
    const state = fixture(resolveActiveSelectionPane(session, query))
    const run = vi.fn(async () => {})
    await deliverSelectionToPane([record], state.acquire, run, state.failed)
    expect(query).toHaveBeenCalledWith([
      'display-message',
      '-p',
      '-t',
      'summitflow-abc',
      '#{pane_id}',
    ])
    expect(run).toHaveBeenCalledWith(
      sendTextTargetArgs({ socket: null, session: '%42' }, '[Link: "example"] '),
    )
    expect(state.delivered).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid external pane identity without sending', async () => {
    const session: TmuxTarget = { socket: null, session: 'summitflow-abc' }
    const state = fixture(resolveActiveSelectionPane(session, async () => '%42\n%43\n'))
    const run = vi.fn(async () => {})
    await deliverSelectionToPane([record], state.acquire, run, state.failed)
    expect(run).not.toHaveBeenCalled()
    expect(state.failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'external selection pane id is invalid' }),
    )
    expect(state.owners.isHeld('widget')).toBe(false)
  })

  it('keeps replacement out until the bounded send completes and targets the exact pane', async () => {
    const state = fixture()
    const send = deferred<void>()
    const run = vi.fn(() => send.promise)
    const request = deliverSelectionToPane([record], state.acquire, run, state.failed)
    await Promise.resolve()
    expect(run).toHaveBeenCalledWith(sendTextTargetArgs(pane, '[Link: "example"] '))
    expect(state.owners.acquire('widget')).toBeNull()
    send.resolve()
    await request
    expect(state.delivered).toHaveBeenCalledWith([record])
    expect(state.owners.acquire('widget')).not.toBeNull()
  })

  it('suppresses the toast when the original window closes and reopens before tmux responds', async () => {
    const state = fixture()
    const send = deferred<void>()
    const request = deliverSelectionToPane(
      [record],
      state.acquire,
      () => send.promise,
      state.failed,
    )
    await Promise.resolve()
    state.reopen()
    send.resolve()
    await request
    expect(state.delivered).not.toHaveBeenCalled()
    expect(state.owners.isHeld('widget')).toBe(false)
  })

  it('does not send if an external pane lookup becomes stale before it resolves', async () => {
    const lookup = deferred<TmuxTarget>()
    const state = fixture(lookup.promise)
    const run = vi.fn(async () => {})
    const request = deliverSelectionToPane([record], state.acquire, run, state.failed)
    state.replace()
    lookup.resolve(pane)
    await request
    expect(run).not.toHaveBeenCalled()
    expect(state.owners.isHeld('widget')).toBe(false)
  })

  it('releases ownership on timeout and permits a later retry', async () => {
    const state = fixture()
    const run = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(undefined)
    await deliverSelectionToPane([record], state.acquire, run, state.failed)
    expect(state.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'timeout' }))
    expect(state.owners.isHeld('widget')).toBe(false)
    await deliverSelectionToPane([record], state.acquire, run, state.failed)
    expect(run).toHaveBeenCalledTimes(2)
    expect(state.delivered).toHaveBeenCalledTimes(1)
  })

  it('releases ownership when target construction throws after acquisition', async () => {
    const state = fixture()
    const run = vi.fn(async () => {})
    const acquire = (): SelectionDeliveryLease | null => {
      const owner = state.owners.acquire('widget')
      if (!owner) return null
      return createSelectionDeliveryLease(
        () => {
          throw new Error('target lookup failed')
        },
        () => {
          state.owners.release(owner)
        },
      )
    }
    await deliverSelectionToPane([record], acquire, run, state.failed)
    expect(state.failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'target lookup failed' }),
    )
    expect(run).not.toHaveBeenCalled()
    expect(state.owners.isHeld('widget')).toBe(false)
  })

  it('drops a selection while replacement owns the widget', async () => {
    const state = fixture()
    const replacement = state.owners.acquire('widget')
    const run = vi.fn(async () => {})
    await deliverSelectionToPane([record], state.acquire, run, state.failed)
    expect(run).not.toHaveBeenCalled()
    expect(state.delivered).not.toHaveBeenCalled()
    if (replacement) state.owners.release(replacement)
  })
})
