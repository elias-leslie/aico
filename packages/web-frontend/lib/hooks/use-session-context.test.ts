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

it('writes a short label', () => {
  expect(contextLabel(640)).toBe('640')
  expect(contextLabel(1_000)).toBe('1k')
  expect(contextLabel(12_528)).toBe('13k')
  expect(contextLabel(4_500)).toBe('4.5k')
  expect(contextLabel(206_151)).toBe('206k')
})
