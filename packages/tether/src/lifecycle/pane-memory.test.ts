import { describe, expect, it } from 'vitest'
import { ForegroundPaneMemory, type PaneMemoryHost } from './pane-memory'

const A = 'tmux-spawn-6019d1b3-0bc2-4cc8-811f-f2a5615c140f.scope'
const B = 'tmux-spawn-7dcd5091-db97-423d-a3aa-57b784f0a0c9.scope'
const STALE = 'tmux-spawn-88e4121b-a199-4f2d-9827-e613d8d05ee2.scope'

function host(protectedAtStart: string[] = []) {
  const calls: string[] = []
  const low = new Map<string, string>(protectedAtStart.map((unit) => [unit, '2G']))
  const fake: PaneMemoryHost = {
    async setMemoryLow(unit, value) {
      calls.push(`${unit}=${value}`)
      low.set(unit, value)
    },
    async protectedScopes() {
      return [...low].filter(([, value]) => value !== '0').map(([unit]) => unit)
    },
  }
  return { fake, calls, low }
}

describe('ForegroundPaneMemory', () => {
  it('protects the focused pane and releases the previous one', async () => {
    const { fake, low } = host()
    const memory = new ForegroundPaneMemory(fake, () => {})
    await memory.focus(A)
    expect(low.get(A)).toBe('2G')
    await memory.focus(B)
    expect(low.get(B)).toBe('2G')
    expect(low.get(A)).toBe('0')
    expect(memory.foreground).toBe(B)
  })

  it('clears panes a previous daemon left protected on the first move only', async () => {
    const { fake, low, calls } = host([STALE])
    const memory = new ForegroundPaneMemory(fake, () => {})
    await memory.focus(A)
    expect(low.get(STALE)).toBe('0')
    calls.length = 0
    await memory.focus(A)
    expect(calls).toEqual([])
  })

  it('ignores anything that is not a pane scope', async () => {
    const { fake, calls } = host()
    const memory = new ForegroundPaneMemory(fake, () => {})
    await memory.focus(null)
    await memory.focus('app.slice')
    expect(calls).toEqual([])
  })

  it('keeps the old foreground when the new pane cannot be protected', async () => {
    const { fake, low } = host()
    const logs: string[] = []
    const memory = new ForegroundPaneMemory(fake, (message) => logs.push(message))
    await memory.focus(A)
    fake.setMemoryLow = async () => {
      throw new Error('unit not found')
    }
    await memory.focus(B)
    expect(memory.foreground).toBe(A)
    expect(low.get(A)).toBe('2G')
    expect(logs[0]).toContain('could not protect')
  })
})
