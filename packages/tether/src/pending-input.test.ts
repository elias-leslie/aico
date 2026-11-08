import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeDelivered } from '@aico/session-engine/tui/adapters/claude-code'
import { codexDelivered } from '@aico/session-engine/tui/adapters/codex'
import { piDelivered } from '@aico/session-engine/tui/adapters/pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PendingInputs } from './pending-input'

let dir: string
let now: number
const inputs = () => new PendingInputs(dir, () => now)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-input-'))
  now = 1_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PendingInputs', () => {
  it('survives a restart, private to the account', () => {
    inputs().add('aaaa1111', { text: 'hello', state: 'sent' })
    expect(statSync(join(dir, 'aaaa1111.jsonl')).mode & 0o777).toBe(0o600)
    expect(inputs().list('aaaa1111')).toEqual([{ text: 'hello', state: 'sent', at: now }])
  })

  it('reads past a torn last line and a rewrite a crash cut short', () => {
    inputs().add('aaaa1111', { text: 'whole', state: 'sent' })
    const file = join(dir, 'aaaa1111.jsonl')
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"at":5,"te`)
    writeFileSync(join(dir, 'aaaa1111.jsonl.9.tmp'), 'partial')
    const store = inputs()
    expect(store.list('aaaa1111').map((e) => e.text)).toEqual(['whole'])
    expect(readdirSync(dir)).toEqual(['aaaa1111.jsonl'])
  })

  it('drops a message and what came before once it arrives, keeping what came after', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'one', state: 'sent' }, now)
    store.add('aaaa1111', { text: 'two\nlines', state: 'sent' }, now + 1)
    store.add('aaaa1111', { text: 'three', state: 'sent' }, now + 2)
    store.seen('aaaa1111', 'two lines', now + 10)
    expect(store.list('aaaa1111').map((e) => e.text)).toEqual(['three'])
    store.seen('aaaa1111', 'three', now + 10)
    expect(store.has('aaaa1111')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not take an earlier prompt with the same words for a later send', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'yes', state: 'sent' }, now)
    store.seen('aaaa1111', 'yes', now - 60_000)
    expect(store.has('aaaa1111')).toBe(true)
  })

  it('ends half-typed and approximate text with any later message', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'half', state: 'typed' }, now)
    store.add('aaaa1111', { text: 'moved cursor', state: 'sent', approx: true }, now + 1)
    store.seen('aaaa1111', 'something else entirely', now + 10)
    expect(store.has('aaaa1111')).toBe(false)
  })

  it('does not end queued or half-typed text on a message sent before it', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'first queued', state: 'sent' }, now)
    store.add('aaaa1111', { text: 'second queued', state: 'sent' }, now + 1)
    store.add('aaaa1111', { text: 'half', state: 'typed' }, now + 2)
    store.seen('aaaa1111', 'first queued', now + 10)
    expect(store.list('aaaa1111').map((e) => e.text)).toEqual(['second queued', 'half'])
    store.seen('aaaa1111', 'something unrecognised', now + 11)
    expect(store.list('aaaa1111').map((e) => e.text)).toEqual(['second queued', 'half'])
  })

  it("doesn't count a harness row as the owner moving on", () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'half', state: 'typed' }, now)
    store.seen('aaaa1111', '<environment_context>cwd</environment_context>', now + 10)
    expect(store.has('aaaa1111')).toBe(true)
  })

  it('does not take a short text for arrived because a longer message contains it', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'ok', state: 'sent' }, now)
    store.seen('aaaa1111', 'deploy the token fix', now + 10)
    expect(store.has('aaaa1111')).toBe(true)
    store.seen('aaaa1111', 'some context\nok', now + 11)
    expect(store.has('aaaa1111')).toBe(false)
  })

  it('keeps text however long a session stays down, and ages it only while the agent runs', () => {
    let clock = now
    const store = new PendingInputs(dir, () => clock)
    store.add('aaaa1111', { text: 'sent before a long outage', state: 'sent' }, now)
    clock = now + 3 * 24 * 3600_000
    expect(store.has('aaaa1111')).toBe(true)
    expect(store.list('aaaa1111')).toHaveLength(1)
    store.expire('aaaa1111')
    expect(store.has('aaaa1111')).toBe(false)
  })

  it('rewrites a torn last line so the next append does not join it', () => {
    inputs().add('aaaa1111', { text: 'whole', state: 'sent' }, now)
    appendFileSync(join(dir, 'aaaa1111.jsonl'), '{"at":1,"text":"to')
    inputs().add('aaaa1111', { text: 'after', state: 'sent' }, now + 1)
    expect(
      inputs()
        .list('aaaa1111')
        .map((e) => e.text),
    ).toEqual(['whole', 'after'])
  })

  it('holds a small amount per session', () => {
    const store = inputs()
    for (let i = 0; i < 12; i += 1) store.add('aaaa1111', { text: `m${i}`, state: 'sent' }, now + i)
    expect(store.list('aaaa1111').map((e) => e.text)[0]).toBe('m4')
    store.add('bbbb2222', { text: 'x'.repeat(100_000), state: 'sent' })
    expect(Buffer.byteLength(store.list('bbbb2222')[0]?.text ?? '')).toBe(8 * 1024)
    expect(readFileSync(join(dir, 'aaaa1111.jsonl'), 'utf8').split('\n').length).toBeLessThan(10)
  })

  it('stops waiting after a day, and forgets ended sessions', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'old', state: 'sent' })
    store.add('bbbb2222', { text: 'gone', state: 'sent' })
    store.retain((id) => id !== 'bbbb2222')
    expect(store.list('bbbb2222')).toEqual([])
    now += 25 * 3600_000
    store.expire('aaaa1111')
    expect(store.has('aaaa1111')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes only what was shown', () => {
    const store = inputs()
    store.add('aaaa1111', { text: 'shown', state: 'sent' }, now)
    const shown = store.list('aaaa1111')
    store.add('aaaa1111', { text: 'later', state: 'sent' }, now + 1)
    store.remove('aaaa1111', shown)
    expect(store.list('aaaa1111').map((e) => e.text)).toEqual(['later'])
  })
})

describe('what each harness says reached the agent', () => {
  const at = '2026-11-08T11:00:00.000Z'
  const when = Date.parse(at)

  it('Claude Code: a prompt row, or a queued prompt taken mid-turn, never a queued one', () => {
    const row = (value: unknown) => JSON.stringify(value)
    expect(
      claudeDelivered(
        row({ type: 'user', timestamp: at, message: { role: 'user', content: 'hi' } }),
      ),
    ).toEqual([{ text: 'hi', at: when }])
    expect(
      claudeDelivered(
        row({
          type: 'queue-operation',
          operation: 'remove',
          reason: 'absorbed_mid_turn',
          content: 'hi',
          timestamp: at,
        }),
      ),
    ).toEqual([{ text: 'hi', at: when }])
    expect(
      claudeDelivered(
        row({ type: 'queue-operation', operation: 'enqueue', content: 'hi', timestamp: at }),
      ),
    ).toEqual([])
    expect(
      claudeDelivered(
        row({
          type: 'user',
          isSidechain: true,
          timestamp: at,
          message: { role: 'user', content: 'to a subagent' },
        }),
      ),
    ).toEqual([])
  })

  it('Codex: a user message in the rollout', () => {
    const line = JSON.stringify({
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    })
    expect(codexDelivered(line).map((row) => row.text)).toEqual(['hi'])
    expect(codexDelivered('{"type":"event_msg","payload":{"type":"task_started"}}')).toEqual([])
  })

  it('Pi: a user message', () => {
    const line = JSON.stringify({
      type: 'message',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(piDelivered(line).map((row) => row.text)).toEqual(['hi'])
    expect(
      piDelivered(
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'hi' } }),
      ),
    ).toEqual([])
  })
})
