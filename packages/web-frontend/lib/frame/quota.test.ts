import { describe, expect, it } from 'vitest'
import type { UsageProvider, UsageReport, UsageWindow } from '../quota-usage'
import { quotaGlances, quotaLine, quotaTitle } from './quota'

const win = (over: Partial<UsageWindow>): UsageWindow => ({
  label: 'weekly',
  state: 'ok',
  left_percent: 80,
  resets_at: null,
  length_seconds: 1000,
  resets_in_seconds: 400,
  text: 'weekly 80% left, resets Nov 13',
  ...over,
})
const provider = (over: Partial<UsageProvider>): UsageProvider => ({
  id: 'claude',
  name: 'Claude',
  status: 'ok',
  summary: null,
  plan: null,
  windows: [win({})],
  credits: null,
  problem: null,
  spend: { unit: null, recorded_since: null, days: [] },
  ...over,
})
const report = (...providers: UsageProvider[]): UsageReport => ({
  as_of: '',
  collected_at: '',
  providers,
})

describe('quota glance', () => {
  it('reads the share left in the tightest window, with how much of its time is gone', () => {
    const [claude] = quotaGlances(
      report(
        provider({
          windows: [
            win({ label: '5h', left_percent: 95, text: '5h 95% left' }),
            win({ left_percent: 79, resets_in_seconds: 600 }),
          ],
        }),
      ),
    )
    expect(claude).toMatchObject({
      state: 'left',
      left: 79,
      gone: 40,
      line: 'Weekly 80% left, resets Nov 13',
    })
  })

  it('says each provider in one line: left, on credits, used up', () => {
    const glances = quotaGlances(
      report(
        provider({}),
        provider({
          id: 'codex',
          name: 'Codex',
          status: 'on_credits',
          credits: { balance: 4571.7, lasts_days: 2.9, text: '4.6K credits' },
          windows: [
            win({ state: 'used_up', left_percent: 0, text: 'weekly used up' }),
          ],
        }),
        provider({
          id: 'opencode-go',
          name: 'OpenCode Go',
          status: 'used_up',
          windows: [
            win({ label: '5h', left_percent: 100 }),
            win({ state: 'used_up', left_percent: 0, text: 'weekly used up' }),
          ],
        }),
      ),
    )
    expect(glances.map((g) => [g.name, g.state, g.left])).toEqual([
      ['Claude', 'left', 80],
      ['Codex', 'credits', 0],
      ['OpenCode Go', 'used_up', 0],
    ])
    expect(glances[1]?.line).toBe('On credits, 4.6K credits left')
    expect(quotaLine(glances)).toBe(
      'Claude 80% · Codex on credits · OpenCode Go used up',
    )
    expect(quotaTitle(glances)).toContain('Bar: share left')
  })

  it('says unknown, not zero, when nothing was read', () => {
    const [glance] = quotaGlances(
      report(
        provider({
          status: 'unknown',
          windows: [win({ state: 'unknown', left_percent: null })],
        }),
      ),
    )
    expect(glance).toMatchObject({ state: 'unknown', left: null, warn: true })
    expect(quotaLine([glance as never])).toBe('Claude unknown')
  })

  it('has no glances before the first read', () => {
    expect(quotaGlances(null)).toEqual([])
  })
})
