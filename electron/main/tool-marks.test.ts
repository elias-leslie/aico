import { describe, expect, it } from 'vitest'
import { TOOL_MARKS, toolMark } from './tool-marks'

describe('toolMark', () => {
  it("draws a known tool's mark in Tether's colour over the built-in accent", () => {
    expect(toolMark('claude-code', '#112233')).toEqual({
      icon: TOOL_MARKS['claude-code']?.icon,
      accent: '#112233',
    })
  })

  it('uses the built-in accent when Tether has no colour or is not answering', () => {
    expect(toolMark('codex', null).accent).toBe(TOOL_MARKS.codex?.accent)
    expect(toolMark('codex').accent).toBe(TOOL_MARKS.codex?.accent)
  })

  it("draws a tool with no mark here as the shell mark in Tether's colour", () => {
    expect(toolMark('aider', '#00aa55')).toEqual({
      icon: TOOL_MARKS.shell?.icon,
      accent: '#00aa55',
    })
    expect(toolMark('aider', null).accent).toBe(TOOL_MARKS.shell?.accent)
    expect(toolMark(null).icon).toBe(TOOL_MARKS.shell?.icon)
  })

  it('ignores a colour that is not #rrggbb', () => {
    expect(toolMark('pi', 'red; background: url(x)').accent).toBe(TOOL_MARKS.pi?.accent)
    expect(toolMark('pi', '').accent).toBe(TOOL_MARKS.pi?.accent)
  })
})
