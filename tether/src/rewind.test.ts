import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PaneKey } from './lifecycle/tmux'
import { claudePromptAt } from './model-switch'
import { RewindRefused, readConfirm, readInput, readMenu, rewindClaude, sameEntry } from './rewind'

// Screens recorded from Claude Code 2.1.316 (a Blank Slate session, 2026-11-01).
const screen = (name: string) =>
  readFileSync(
    join(__dirname, 'test-fixtures', 'model-switch', `claude-rewind-${name}.txt`),
    'utf8',
  )
const TWO = 'Reply with only the word TWO. Do not use any tools.'
const WRITE = 'Use the Write tool to create probe.txt containing the word THREE, then reply DONE.'

/** A window that moves between recorded screens on the keys it is sent; as
 * in Claude Code, a second Escape in a row at the prompt opens the list. */
function window(
  start: string,
  moves: Record<string, Partial<Record<PaneKey, string>>>,
  extra: Record<string, string> = {},
) {
  let at = start
  let armed = false
  const pressed: PaneKey[] = []
  return {
    pressed,
    ops: {
      capture: async () => extra[at] ?? screen(at),
      press: async (key: PaneKey) => {
        pressed.push(key)
        if (at === '0-prompt' && key === 'Escape') {
          if (armed) at = '1-menu'
          armed = !armed
          return
        }
        armed = false
        at = moves[at]?.[key] ?? at
      },
      sleep: async () => {},
    },
  }
}

describe('reading the screens', () => {
  it('reads the list, the picked entry and the input box', () => {
    expect(readMenu(screen('1-menu'))).toEqual({
      entries: ['Reply with only the word ONE. Do not use any tools.', TWO, '(current)'],
      picked: 2,
    })
    expect(readMenu(screen('2-picked'))?.picked).toBe(1)
    expect(readMenu(screen('0-prompt'))).toBeNull()
    expect(readInput(screen('0-prompt'))).toBe('')
    expect(readInput(screen('1-menu'))).toBeNull()
    expect(readInput(screen('4-restored'))).toBe(TWO)
    expect(readInput(screen('5-cleared'))).toBe('')
  })

  it('reads the confirm options, with and without code changes', () => {
    expect(readConfirm(screen('3-confirm'))).toEqual({
      message: TWO,
      options: [
        'Restore conversation',
        'Summarize from here',
        'Summarize up to here',
        'Never mind',
      ],
      picked: 0,
    })
    expect(readConfirm(screen('7-confirm-code'))).toMatchObject({
      message: WRITE,
      options: [
        'Restore code and conversation',
        'Restore conversation',
        'Restore code',
        'Summarize from here',
        'Summarize up to here',
      ],
      picked: 0,
    })
  })

  it('matches an entry whole, or cut to the window with an ellipsis', () => {
    expect(sameEntry('Reply with only the word TWO. Do not…', TWO)).toBe(true)
    expect(sameEntry('Reply with only the word ONE.', TWO)).toBe(false)
    // Cut without the ellipsis is another prompt that starts the same.
    expect(sameEntry('Reply with only the word TWO.', TWO)).toBe(false)
    expect(sameEntry('Fix the failing test in…', 'Fix the failing test in auth')).toBe(true)
  })
})

describe('rewinding', () => {
  it('picks the prompt, restores the conversation only and clears the input', async () => {
    const w = window('0-prompt', {
      '1-menu': { Up: '2-picked' },
      '2-picked': { Enter: '3-confirm' },
      '3-confirm': { Enter: '4-restored' },
      '4-restored': { 'C-u': '5-cleared' },
    })
    expect(await rewindClaude(w.ops, TWO, [])).toEqual({ up: 1, cleared: true })
    expect(w.pressed).toEqual(['Escape', 'Escape', 'Up', 'Enter', 'Enter', 'C-u'])
  })

  it('moves to "Restore conversation" when code changed, never restoring the code', async () => {
    const confirmed = screen('7-confirm-code')
      .replace('❯ 1. Restore code and conversation', '  1. Restore code and conversation')
      .replace('  2. Restore conversation', '❯ 2. Restore conversation')
    const screens: Record<string, string> = {
      picked: screen('6-picked-code'),
      confirm: screen('7-confirm-code'),
      second: confirmed,
    }
    let at = 'menu'
    const pressed: PaneKey[] = []
    const menu = screen('6-picked-code')
      .replace(`  ❯ ${WRITE}`, `    ${WRITE}`)
      .replace('    (current)', '  ❯ (current)')
    const done = await rewindClaude(
      {
        capture: async () =>
          at === 'prompt-start'
            ? screen('0-prompt')
            : at === 'menu'
              ? menu
              : at === 'restored'
                ? screen('4-restored').replace(TWO, WRITE)
                : at === 'cleared'
                  ? screen('5-cleared')
                  : (screens[at] ?? ''),
        press: async (key) => {
          pressed.push(key)
          if (key === 'Up' && at === 'menu') at = 'picked'
          else if (key === 'Enter' && at === 'picked') at = 'confirm'
          else if (key === 'Down' && at === 'confirm') at = 'second'
          else if (key === 'Enter' && at === 'second') at = 'restored'
          else if (key === 'C-u' && at === 'restored') at = 'cleared'
        },
        sleep: async () => {},
      },
      WRITE,
      [],
    ).catch((error) => error)
    // The first capture must show an empty input: here the menu is up already.
    expect(done).toBeInstanceOf(RewindRefused)
    at = 'prompt-start'
    pressed.length = 0
    let escapes = 0
    const result = await rewindClaude(
      {
        capture: async () =>
          at === 'prompt-start'
            ? screen('0-prompt')
            : at === 'menu'
              ? menu
              : at === 'restored'
                ? screen('4-restored').replace(TWO, WRITE)
                : at === 'cleared'
                  ? screen('5-cleared')
                  : (screens[at] ?? ''),
        press: async (key) => {
          pressed.push(key)
          if (key === 'Escape' && ++escapes === 2) at = 'menu'
          else if (key === 'Up' && at === 'menu') at = 'picked'
          else if (key === 'Enter' && at === 'picked') at = 'confirm'
          else if (key === 'Down' && at === 'confirm') at = 'second'
          else if (key === 'Enter' && at === 'second') at = 'restored'
          else if (key === 'C-u' && at === 'restored') at = 'cleared'
        },
        sleep: async () => {},
      },
      WRITE,
      [],
    )
    expect(result).toEqual({ up: 1, cleared: true })
    expect(pressed).toEqual(['Escape', 'Escape', 'Up', 'Enter', 'Down', 'Enter', 'C-u'])
  })

  it('refuses a draft in the input box before any key', async () => {
    const w = window('4-restored', {})
    await expect(rewindClaude(w.ops, TWO, [])).rejects.toMatchObject({ step: 'prompt' })
    expect(w.pressed).toEqual([])
  })

  it('a prompt not in the list closes the menu and refuses', async () => {
    const w = window('0-prompt', {
      '1-menu': { Up: '2-picked', Escape: '0-prompt' },
      '2-picked': { Escape: '0-prompt' },
    })
    await expect(
      rewindClaude(w.ops, 'Some prompt that was never sent here', []),
    ).rejects.toMatchObject({ step: 'pick', reason: 'the list shows another prompt there' })
    // It walked up one, found another prompt there, then backed out.
    expect(w.pressed).toEqual(['Escape', 'Escape', 'Up', 'Escape'])
  })

  it('walks past exactly the later prompts, refusing a list that does not match', async () => {
    const ONE = 'Reply with only the word ONE. Do not use any tools.'
    const onePicked = screen('2-picked')
      .replace(`  ❯ ${TWO}`, `    ${TWO}`)
      .replace(`    ${ONE}`, `  ❯ ${ONE}`)
    const moves = {
      '1-menu': { Up: '2-picked' },
      '2-picked': { Up: 'one', Escape: '0-prompt' },
      one: { Escape: '0-prompt' },
    }
    // ONE, with TWO sent after it: Up twice, each entry checked.
    const ok = window(
      '0-prompt',
      { ...moves, one: { Enter: 'one-confirm' }, 'one-confirm': { Enter: '5-cleared' } },
      { one: onePicked, 'one-confirm': screen('3-confirm').replace(`│ ${TWO}`, `│ ${ONE}`) },
    )
    expect(await rewindClaude(ok.ops, ONE, [TWO])).toEqual({ up: 2, cleared: true })
    expect(ok.pressed).toEqual(['Escape', 'Escape', 'Up', 'Up', 'Enter', 'Enter'])
    // The transcript says another prompt came after ONE: refused at the first step.
    const off = window('0-prompt', moves, { one: onePicked })
    await expect(rewindClaude(off.ops, ONE, ['Something else'])).rejects.toMatchObject({
      step: 'pick',
      reason: 'the list does not match the transcript',
    })
    expect(off.pressed).toEqual(['Escape', 'Escape', 'Up', 'Escape'])
  })

  it('reports a restore whose text it could not clear, as done', async () => {
    const w = window('0-prompt', {
      '1-menu': { Up: '2-picked' },
      '2-picked': { Enter: '3-confirm' },
      '3-confirm': { Enter: '4-restored' },
    })
    expect(await rewindClaude(w.ops, TWO, [])).toEqual({ up: 1, cleared: false })
    expect(w.pressed).toEqual(['Escape', 'Escape', 'Up', 'Enter', 'Enter', 'C-u'])
  })
})

describe('the prompt to rewind to', () => {
  it('is read from the transcript, with the first lines of the prompts after it', () => {
    const row = (uuid: string, content: unknown, extra = {}) =>
      JSON.stringify({ type: 'user', uuid, message: { role: 'user', content }, ...extra })
    const a = '11111111-1111-4111-8111-111111111111'
    const transcript = [
      row(a, 'Do the thing\nwith detail'),
      row('22222222-2222-4222-8222-222222222222', [{ type: 'tool_result', content: 'x' }]),
      row('33333333-3333-4333-8333-333333333333', 'Do the thing'),
      row('44444444-4444-4444-8444-444444444444', 'meta', { isMeta: true }),
    ].join('\n')
    expect(claudePromptAt(transcript, a)).toEqual({
      text: 'Do the thing\nwith detail',
      after: ['Do the thing'],
    })
    expect(claudePromptAt(transcript, '55555555-5555-4555-8555-555555555555')).toBeNull()
  })

  it('skips what Claude Code writes itself after a stop (live probe, 2026-11-01)', () => {
    const row = (uuid: string, content: unknown, extra = {}) =>
      JSON.stringify({ type: 'user', uuid, message: { role: 'user', content }, ...extra })
    const a = '11111111-1111-4111-8111-111111111111'
    const transcript = [
      row(a, 'Run the shell command: sleep 25', { origin: { kind: 'human' } }),
      row('22222222-2222-4222-8222-222222222222', '<task-notification>\n<task-id>b</task-id>', {
        origin: { kind: 'task-notification' },
      }),
      row('33333333-3333-4333-8333-333333333333', [
        { type: 'text', text: '[Request interrupted by user]' },
      ]),
      row('44444444-4444-4444-8444-444444444444', '[Request interrupted by user for tool use]'),
      row('55555555-5555-4555-8555-555555555555', 'A notice', { origin: { kind: 'channel' } }),
      row('66666666-6666-4666-8666-666666666666', 'Reply LIVE2', { origin: { kind: 'human' } }),
    ].join('\n')
    expect(claudePromptAt(transcript, a)).toEqual({
      text: 'Run the shell command: sleep 25',
      after: ['Reply LIVE2'],
    })
  })
})
