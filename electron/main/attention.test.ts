import { describe, expect, it } from 'vitest'
import {
  type AgentState,
  Attention,
  agentName,
  DONE_FLASH_MS,
  formatAge,
  groupRows,
  PUSH_AFTER_MS,
  pushBody,
  pushEventLine,
  pushOutcome,
  RISE_AFTER_MS,
} from './attention'

function harness() {
  let clock = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const focused = new Set<string>()
  const flashes: [string, boolean][] = []
  const tray: boolean[] = []
  const pushes: string[] = []
  const attends: string[] = []
  const attention = new Attention({
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
    attend: (id, mode, stage) => attends.push(`${id}:${mode}:${stage}`),
  })
  const advance = (ms: number) => {
    clock += ms
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock && timers.delete(id)) timer.fn()
    }
  }
  const set = (id: string, state: AgentState) => attention.update(id, state)
  return { attention, focused, flashes, tray, pushes, attends, advance, set }
}

describe('Attention', () => {
  it('escalates an unseen blocked window: fresh, rising at 30 s, urgent at 2 min', () => {
    const h = harness()
    h.set('a', 'working')
    h.set('a', 'blocked')
    expect(h.attends).toEqual(['a:blocked:fresh'])
    h.advance(RISE_AFTER_MS)
    expect(h.attends.at(-1)).toBe('a:blocked:rising')
    expect(h.attention.urgent()).toEqual([])
    h.advance(PUSH_AFTER_MS - RISE_AFTER_MS)
    expect(h.attends.at(-1)).toBe('a:blocked:urgent')
    expect(h.attention.urgent()).toEqual(['a'])
    h.focused.add('a')
    h.attention.focused('a')
    expect(h.attends.at(-1)).toBe('a:none:fresh')
    expect(h.attention.urgent()).toEqual([])
  })

  it('answering before 30 s clears the window and never rises', () => {
    const h = harness()
    h.set('a', 'blocked')
    h.set('a', 'working')
    h.advance(PUSH_AFTER_MS)
    expect(h.attends).toEqual(['a:blocked:fresh', 'a:none:fresh'])
  })

  it('a finished window shows finished until it is focused', () => {
    const h = harness()
    h.set('a', 'working')
    h.set('a', 'idle')
    expect(h.attends).toEqual(['a:finished:fresh'])
    h.advance(PUSH_AFTER_MS)
    expect(h.attends).toEqual(['a:finished:fresh'])
    h.attention.focused('a')
    expect(h.attends.at(-1)).toBe('a:none:fresh')
  })

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

  it('pushes again for each new unseen block; Nightshift dedupes repeats', () => {
    const h = harness()
    h.set('a', 'blocked')
    h.advance(PUSH_AFTER_MS)
    h.set('a', 'working')
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

  it("names the agent for the push from Tether's tools", () => {
    const tools = [
      { slug: 'claude-code', name: 'Claude Code', processName: 'claude', aliases: ['claude'] },
      { slug: 'codex', name: 'Codex', processName: 'codex', aliases: [] },
      { slug: 'pi', name: 'Pi', processName: 'pi-coding-agent' },
    ]
    expect(pushBody(agentName('claude-status', tools, 'Shell'), 'tether')).toBe(
      'Claude Code in tether is waiting for you',
    )
    expect(agentName('claude-hook', tools, 'Shell')).toBe('Claude Code')
    expect(agentName('codex-rollout', tools, 'Shell')).toBe('Codex')
    // a tool renamed in Tether is named the new way
    expect(agentName('codex-rollout', [{ slug: 'codex', name: 'OpenAI Codex' }], 'Shell')).toBe(
      'OpenAI Codex',
    )
    // no state source, or one naming no tool: the session's own tool
    expect(agentName(undefined, tools, 'Pi')).toBe('Pi')
    expect(agentName('none', tools, 'Pi')).toBe('Pi')
    expect(agentName('gemini-status', tools, 'Shell')).toBe('Shell')
    // Tether not answering (no tools yet): the session's own tool, never a guess
    expect(agentName('claude-status', [], 'claude-code')).toBe('claude-code')
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

describe('push outcome', () => {
  it('reads Nightshift sent and spooled as sent', () => {
    expect(pushOutcome(null, 'sent 2/2\n')).toEqual({ result: 'sent', nightshift: 'sent_2/2' })
    expect(pushOutcome(null, 'spooled\n').result).toBe('sent')
  })

  it('reads the result from the last line, after Nightshift diagnostics', () => {
    expect(pushOutcome(null, 'delivery record not written: OSError\nsent 1/1\n')).toEqual({
      result: 'sent',
      nightshift: 'sent_1/1',
    })
  })

  it('reads a Nightshift dedupe as suppressed, not as a push', () => {
    expect(pushOutcome(null, 'suppressed\n')).toEqual({
      result: 'suppressed',
      nightshift: 'suppressed',
    })
  })

  it('reads anything else as failed, with the exit code', () => {
    expect(pushOutcome(null, 'no-subscribers\n')).toEqual({
      result: 'failed',
      nightshift: 'no-subscribers',
    })
    expect(pushOutcome({ code: 1 }, 'gone,rejected:403\n')).toEqual({
      result: 'failed',
      nightshift: 'gone,rejected:403',
      exit: '1',
    })
    expect(pushOutcome({ code: 'ENOENT' }, '')).toEqual({ result: 'failed', exit: 'ENOENT' })
    expect(pushOutcome({ code: null, killed: true }, '')).toEqual({
      result: 'failed',
      exit: 'killed',
    })
  })

  it('writes one ids-only journal line', () => {
    expect(pushEventLine('w1', pushOutcome(null, 'suppressed\n'))).toBe(
      '[aico:event] needs_you_push result=suppressed widget=w1 nightshift=suppressed',
    )
    expect(pushEventLine('w2', pushOutcome({ code: 1 }, 'rejected:410\n'))).toBe(
      '[aico:event] needs_you_push result=failed widget=w2 nightshift=rejected:410 exit=1',
    )
    // Output that is not a Nightshift result word (say, a traceback) stays out of the journal.
    const odd = pushEventLine(
      'w3',
      pushOutcome(
        { code: 1 },
        'Traceback (most recent call last):\n  File "x"\nOSError: Claude in tether\n',
      ),
    )
    expect(odd).toBe('[aico:event] needs_you_push result=failed widget=w3 exit=1')
  })
})
