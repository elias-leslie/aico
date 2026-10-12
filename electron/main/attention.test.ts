import { describe, expect, it } from 'vitest'
import {
  type AgentState,
  Attention,
  agentName,
  DONE_FLASH_MS,
  formatAge,
  groupRows,
  PUSH_AFTER_MS,
  PUSH_COOLDOWN_MS,
  pushBody,
} from './attention'

function harness() {
  let clock = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const focused = new Set<string>()
  const flashes: [string, boolean][] = []
  const tray: boolean[] = []
  const pushes: string[] = []
  const attention = new Attention({
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: clock + ms, fn })
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
    isFocused: (id) => focused.has(id),
    flash: (id, on) => flashes.push([id, on]),
    needsYou: (on) => tray.push(on),
    push: (id) => pushes.push(id),
  })
  const advance = (ms: number) => {
    clock += ms
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock && timers.delete(id)) timer.fn()
    }
  }
  const set = (id: string, state: AgentState) => attention.update(id, state)
  return { attention, focused, flashes, tray, pushes, advance, set }
}

describe('Attention', () => {
  it('flashes, shows needs-you and pushes once for an unfocused blocked session', () => {
    const h = harness()
    h.set('a', 'working')
    h.set('a', 'blocked')
    expect(h.flashes).toEqual([['a', true]])
    expect(h.tray).toEqual([true])
    h.advance(PUSH_AFTER_MS - 1)
    expect(h.pushes).toEqual([])
    h.advance(1)
    expect(h.pushes).toEqual(['a'])
    // Answered: the session goes back to work.
    h.set('a', 'working')
    expect(h.flashes.at(-1)).toEqual(['a', false])
    expect(h.tray).toEqual([true, false])
  })

  it('clears on focus and never pushes for a seen prompt', () => {
    const h = harness()
    h.set('a', 'blocked')
    h.focused.add('a')
    h.attention.focused('a')
    expect(h.flashes).toEqual([
      ['a', true],
      ['a', false],
    ])
    expect(h.tray).toEqual([true, false])
    h.advance(PUSH_AFTER_MS)
    expect(h.pushes).toEqual([])
  })

  it('does nothing for a session blocked in the focused window', () => {
    const h = harness()
    h.focused.add('a')
    h.set('a', 'blocked')
    h.advance(PUSH_AFTER_MS)
    expect(h.flashes).toEqual([])
    expect(h.tray).toEqual([])
    expect(h.pushes).toEqual([])
  })

  it('keeps the tray on while any session needs the owner', () => {
    const h = harness()
    h.set('a', 'blocked')
    h.set('b', 'blocked')
    h.set('a', 'idle')
    expect(h.tray).toEqual([true])
    expect(h.attention.needing()).toEqual(['b'])
    h.attention.removed('b')
    expect(h.tray).toEqual([true, false])
  })

  it('cools pushes down per session', () => {
    const h = harness()
    h.set('a', 'blocked')
    h.advance(PUSH_AFTER_MS)
    h.set('a', 'working')
    h.set('a', 'blocked')
    h.advance(PUSH_AFTER_MS)
    expect(h.pushes).toEqual(['a'])
    h.set('a', 'working')
    h.advance(PUSH_COOLDOWN_MS)
    h.set('a', 'blocked')
    h.advance(PUSH_AFTER_MS)
    expect(h.pushes).toEqual(['a', 'a'])
  })

  it('flashes a finished turn only after 30 s unfocused and idle, without the tray', () => {
    const h = harness()
    h.set('a', 'working')
    h.set('a', 'idle')
    h.advance(DONE_FLASH_MS - 1)
    expect(h.flashes).toEqual([])
    h.advance(1)
    expect(h.flashes).toEqual([['a', true]])
    expect(h.tray).toEqual([])
    h.set('a', 'working')
    expect(h.flashes.at(-1)).toEqual(['a', false])
  })

  it('skips the done flash when the owner looks or the agent resumes', () => {
    const h = harness()
    h.set('a', 'working')
    h.set('a', 'idle')
    h.focused.add('a')
    h.attention.focused('a')
    h.advance(DONE_FLASH_MS)
    expect(h.flashes).toEqual([])
    h.focused.delete('a')
    h.set('a', 'working')
    h.set('a', 'idle')
    h.set('a', 'working')
    h.advance(DONE_FLASH_MS)
    expect(h.flashes).toEqual([])
    // idle without a turn before it (startup, unknown -> idle) is not "done"
    h.set('b', 'unknown')
    h.set('b', 'idle')
    h.advance(DONE_FLASH_MS)
    expect(h.flashes).toEqual([])
  })

  it('names the agent for the push', () => {
    expect(pushBody(agentName('claude-status', 'Shell'), 'tether')).toBe(
      'Claude in tether is waiting for you',
    )
    expect(agentName('codex-rollout', 'Shell')).toBe('Codex')
    expect(agentName(undefined, 'Pi')).toBe('Pi')
  })
})

describe('attention groups', () => {
  it('groups most-urgent first, with ages, and re-sorts after focus', () => {
    const h = harness()
    const now = 10 * 60_000
    h.attention.update('idle', 'idle', now - 3_600_000)
    h.attention.update('work', 'working', now - 60_000)
    h.attention.update('done', 'working', now - 600_000)
    h.attention.update('done', 'idle', now - 60_000)
    h.attention.update('wait-new', 'blocked', now - 60_000)
    h.attention.update('wait-old', 'blocked', now - 180_000)
    const ids = ['idle', 'work', 'done', 'wait-new', 'wait-old'].map((id) => ({ id }))
    const rows = groupRows(ids, h.attention, now)
    expect(rows.map((r) => [r.item.id, r.group, r.detail])).toEqual([
      ['wait-old', 'needs-you', 'waiting 3m'],
      ['wait-new', 'needs-you', 'waiting 1m'],
      ['done', 'finished', 'done 1m'],
      ['work', 'working', 'working 1m'],
      ['idle', 'idle', 'idle 1h'],
    ])
    h.attention.focused('wait-old')
    h.attention.focused('done')
    const after = groupRows(ids, h.attention, now)
    expect(after.map((r) => [r.item.id, r.group, r.detail])).toEqual([
      ['wait-new', 'needs-you', 'waiting 1m'],
      ['work', 'working', 'working 1m'],
      ['done', 'idle', 'idle 1m'],
      ['wait-old', 'idle', 'waiting 3m'],
      ['idle', 'idle', 'idle 1h'],
    ])
  })

  it('formats ages compactly', () => {
    expect(formatAge(30_000)).toBe('<1m')
    expect(formatAge(3 * 60_000)).toBe('3m')
    expect(formatAge(2 * 3_600_000)).toBe('2h')
    expect(formatAge(50 * 3_600_000)).toBe('2d')
  })
})
