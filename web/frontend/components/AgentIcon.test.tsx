import { describe, expect, it } from 'vitest'
import { getAgentColor } from './AgentIcon'

describe('getAgentColor', () => {
  it("uses the tool's own color, including the accent green", () => {
    expect(getAgentColor('codex', '#123456')).toBe('#123456')
    expect(getAgentColor('mine', '#00FF9F')).toBe('#00FF9F')
  })

  it('falls back to the built-in color for the slug, then the accent', () => {
    expect(getAgentColor('claude-code', null)).toBe('#D97757')
    expect(getAgentColor('claude-code', '')).toBe('#D97757')
    expect(getAgentColor('mine')).toBe('var(--term-accent)')
  })
})
