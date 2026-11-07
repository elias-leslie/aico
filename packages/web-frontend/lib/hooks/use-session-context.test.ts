import { expect, it } from 'vitest'
import { contextLabel, contextTokensOf } from './use-session-context'

it("reads the session's newest conversation, and unknown stays unknown", () => {
  expect(
    contextTokensOf([
      { tool: 'codex', startedAt: 1, contextTokens: 5 },
      { tool: 'codex', startedAt: 9, contextTokens: 206_151 },
    ]),
  ).toBe(206_151)
  expect(
    contextTokensOf([
      { tool: 'codex', startedAt: 1, contextTokens: 5 },
      { tool: 'codex', startedAt: 9, contextTokens: null },
    ]),
  ).toBeNull()
  expect(contextTokensOf([])).toBeNull()
})

it('reads the conversation that wrote last, not a side run started later', () => {
  expect(
    contextTokensOf(
      [
        {
          tool: 'claude-code',
          startedAt: 1,
          endedAt: 100,
          contextTokens: 94_991,
        },
        {
          tool: 'claude-code',
          startedAt: 50,
          endedAt: 51,
          contextTokens: 28_542,
        },
      ],
      'claude',
    ),
  ).toBe(94_991)
})

it("prefers the session's own tool over a side run it started", () => {
  const items = [
    { tool: 'claude-code', startedAt: 1, contextTokens: 233_069 },
    { tool: 'codex', startedAt: 9, contextTokens: 25_596 },
  ]
  expect(contextTokensOf(items, 'claude')).toBe(233_069)
  expect(contextTokensOf(items, 'claude-code')).toBe(233_069)
  expect(contextTokensOf(items, 'pi')).toBe(25_596)
})

it('writes a short label', () => {
  expect(contextLabel(640)).toBe('640')
  expect(contextLabel(1_000)).toBe('1k')
  expect(contextLabel(12_528)).toBe('13k')
  expect(contextLabel(4_500)).toBe('4.5k')
  expect(contextLabel(206_151)).toBe('206k')
})
