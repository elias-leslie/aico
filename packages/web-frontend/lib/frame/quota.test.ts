import { describe, expect, it } from 'vitest'
import type { StatusRow } from '../status'
import { quotaGlances, quotaLine } from './quota'

const row = (id: string, what: string, meaning: string, state = 'ok') =>
  ({ id, what, meaning, state, shown: state }) as unknown as StatusRow

describe('quota glance', () => {
  it('reads each subscription row and says one line, tightest window first', () => {
    const glances = quotaGlances([
      row(
        'usage/claude',
        'Claude usage',
        '82% left this week; 95% left in 5 hours.',
      ),
      row(
        'usage/codex',
        'Codex usage',
        'Running on credits. 5h unknown; weekly used up until Nov 11, 5:35 AM; 4.6K credits left.',
      ),
      row(
        'usage/opencode-go',
        'OpenCode Go usage',
        'Weekly used up until Nov 8, 7:00 PM. 5h 100% left, resets Nov 7, 1:52 AM; monthly 5% left.',
        'warn',
      ),
      row('usage/old', 'Old usage', 'Used up. Resets Friday.', 'warn'),
      row('jobs/usage-collect', 'Usage collect', 'Ran.'),
    ])
    expect(glances.map((g) => [g.name, g.state, g.left])).toEqual([
      ['Claude', 'left', 82],
      ['Codex', 'credits', null],
      ['OpenCode Go', 'used_up', null],
      ['Old', 'used_up', null],
    ])
    expect(quotaLine(glances)).toBe(
      'Claude 82% · Codex on credits · OpenCode Go, Old used up',
    )
  })

  it('says unknown, not zero, when a row has no numbers', () => {
    const glances = quotaGlances([
      row('usage/claude', 'Claude usage', 'Unknown. Not read yet.', 'unknown'),
    ])
    expect(glances[0]).toMatchObject({
      state: 'unknown',
      left: null,
      warn: true,
    })
    expect(quotaLine(glances)).toBe('Claude unknown')
  })
})
