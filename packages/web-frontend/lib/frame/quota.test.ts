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
      row('usage/codex', 'Codex usage', 'Running on credits. Plan used up.'),
      row(
        'usage/opencode-go',
        'OpenCode Go usage',
        'Used up. Resets Friday.',
        'warn',
      ),
      row('jobs/usage-collect', 'Usage collect', 'Ran.'),
    ])
    expect(glances.map((g) => [g.name, g.state, g.left])).toEqual([
      ['Claude', 'left', 82],
      ['Codex', 'credits', null],
      ['OpenCode Go', 'used_up', null],
    ])
    expect(quotaLine(glances)).toBe(
      'Claude 82% · Codex on credits · OpenCode Go used up',
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
