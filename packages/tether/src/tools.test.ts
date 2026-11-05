import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS, formatCommand, parseCommand, ToolValidationError } from './tools'

describe('parseCommand', () => {
  it("splits the web app's plain command strings", () => {
    expect(parseCommand('  claude --dangerously-skip-permissions ')).toEqual([
      'claude',
      '--dangerously-skip-permissions',
    ])
    expect(parseCommand('')).toEqual([])
  })

  it('rejects quoting, expansion and control operators', () => {
    for (const command of ['a; b', 'a && b', 'echo $HOME', "a 'b c'", 'a > f', 'a `b`', 'a *']) {
      expect(() => parseCommand(command)).toThrow(ToolValidationError)
    }
  })
})

describe('formatCommand', () => {
  it('shell-quotes only words that need it', () => {
    expect(formatCommand(['codex', '--yolo'])).toBe('codex --yolo')
    expect(formatCommand(['x', "it's here"])).toBe("x 'it'\\''s here'")
  })
})

it('retires the Agent Hub tool and root backend', async () => {
  const { isRootCreateTool } = await import('./lifecycle/tui/registry')
  expect(DEFAULT_TOOLS.some((tool) => tool.slug === 'agent-hub')).toBe(false)
  expect(isRootCreateTool('agent-hub')).toBe(false)
})
