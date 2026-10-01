import { describe, expect, it, vi } from 'vitest'
import {
  type ExternalView,
  type ExternalViewOperations,
  reconcileClosedExternalViews,
  reconcileSessionViews,
} from './external-view-reconciliation'
import { LifecycleOwnerLock } from './lifecycle-guard'

function view(id: string, session: string, socket: string | null = null): ExternalView {
  return {
    id,
    sessionId: `external-tmux-${id}`,
    externalTmuxSession: session,
    externalTmuxSocket: socket,
  }
}

function fixture(initial: ExternalView[]) {
  const rows = new Map(initial.map((row) => [row.id, row]))
  const open = new Set<string>()
  const owners = new LifecycleOwnerLock()
  const probe = vi.fn<ExternalViewOperations['probe']>().mockResolvedValue('absent')
  const forget = vi.fn<ExternalViewOperations['forget']>((row) => {
    if (rows.get(row.id) !== row) return false
    rows.delete(row.id)
    return true
  })
  const operations: ExternalViewOperations = {
    list: () => [...rows.values()],
    acquire: (id) => owners.acquire(id),
    release: (_id, owner) => {
      owners.release(owner)
    },
    probe,
    forget,
  }
  return { rows, open, owners, probe, forget, operations }
}

describe('closed external view reconciliation', () => {
  const ended = 'summitflow-dbbd960a-90a0-47cc-972b-33632f08b4e9'
  const running = 'summitflow-3b52af2a-986a-431c-9ecc-670eb81d3374'

  it('closes an open A-Term view when End elsewhere proves its target absent', async () => {
    const state = fixture([view('stale', ended)])
    state.open.add('stale')
    const close = vi.fn((id: string) => state.open.delete(id))

    await reconcileSessionViews([], {
      ...state.operations,
      openViews: () => [...state.open],
      close,
    })

    expect(state.rows.has('stale')).toBe(false)
    expect(close).toHaveBeenCalledExactlyOnceWith('stale')
    expect(state.open.size).toBe(0)
  })

  it('forgets only a closed A-Term view whose exact target is proven absent', async () => {
    const stale = view('stale', ended)
    const live = view('live', running)
    const otherSocket = view('other', 'legacy-external', '/tmp/legacy.sock')
    const aico = view('owned', '')
    aico.externalTmuxSession = null
    const state = fixture([stale, live, otherSocket, aico])

    expect(await reconcileClosedExternalViews([running], state.operations)).toBe(1)
    expect([...state.rows.keys()]).toEqual(['live', 'other', 'owned'])
    expect(state.probe).toHaveBeenCalledExactlyOnceWith({ socket: null, session: ended })
    expect(state.forget).toHaveBeenCalledExactlyOnceWith(stale)
    expect(await reconcileClosedExternalViews([running], state.operations)).toBe(0)
  })

  it.each([
    'unknown',
    'present',
  ] as const)('retains a view when its exact target is %s', async (presence) => {
    const stale = view('stale', ended)
    const state = fixture([stale])
    state.probe.mockResolvedValue(presence)

    expect(await reconcileClosedExternalViews([], state.operations)).toBe(0)
    expect(state.rows.get('stale')).toBe(stale)
    expect(state.forget).not.toHaveBeenCalled()
  })

  it.each([
    'present',
    'unknown',
  ] as const)('keeps an open view when target presence is %s', async (presence) => {
    const state = fixture([view('stale', ended)])
    state.open.add('stale')
    state.probe.mockResolvedValue(presence)
    const close = vi.fn()
    expect(
      await reconcileSessionViews([], {
        ...state.operations,
        openViews: () => [...state.open],
        close,
      }),
    ).toBe(0)
    expect(close).not.toHaveBeenCalled()
    expect(state.open.has('stale')).toBe(true)
  })

  it('does not forget a row replaced while the probe runs', async () => {
    const stale = view('stale', ended)
    const state = fixture([stale])
    state.probe.mockImplementation(async () => {
      state.rows.set('stale', view('stale', running))
      return 'absent'
    })
    expect(await reconcileClosedExternalViews([], state.operations)).toBe(0)
    expect(state.rows.get('stale')?.externalTmuxSession).toBe(running)
    expect(state.forget).not.toHaveBeenCalled()
  })

  it('leaves a row alone while another lifecycle action owns it', async () => {
    const stale = view('stale', ended)
    const state = fixture([stale])
    const owner = state.owners.acquire('stale')
    expect(owner).not.toBeNull()

    expect(await reconcileClosedExternalViews([], state.operations)).toBe(0)
    expect(state.probe).not.toHaveBeenCalled()
    expect(state.rows.get('stale')).toBe(stale)
    if (owner) state.owners.release(owner)
  })
})
