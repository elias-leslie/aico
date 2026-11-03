import { describe, expect, it } from 'vitest'
import { forWorkspace } from './blank-slate'
import { forRole, type LaneTools } from './lane-tools'
import { launchLine } from './launch'
import type { TuiSpec } from './spec'

const claude: TuiSpec = {
  slug: 'claude-code',
  displayName: 'Claude Code',
  icon: '',
  accent: '',
  order: 0,
  enabled: true,
  command: ['claude', '--dangerously-skip-permissions'],
  processName: 'claude',
}

const profiles: LaneTools = {
  about: 'test',
  'claude-code': {
    env: { LEAN: '1' },
    roles: {
      coordinator: false,
      implementation: { args: ['--disallowedTools=A'] },
      '*': { args: ['--disallowedTools=A,B'] },
    },
  },
}

describe('forRole', () => {
  it('gives a listed role the tool env and its own args after the command', () => {
    const spec = forRole(claude, 'implementation', profiles)
    expect(spec.command).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--disallowedTools=A',
    ])
    expect(spec.env).toEqual({ LEAN: '1' })
  })

  it("gives any other role '*'", () => {
    expect(forRole(claude, 'review', profiles).command.at(-1)).toBe('--disallowedTools=A,B')
  })

  it('leaves a full-harness role, a session with no role and an unlisted tool alone', () => {
    expect(forRole(claude, 'coordinator', profiles)).toBe(claude)
    expect(forRole(claude, null, profiles)).toBe(claude)
    expect(forRole(claude, undefined, profiles)).toBe(claude)
    const codex = { ...claude, slug: 'codex', command: ['codex', '--yolo'] }
    expect(forRole(codex, 'implementation', profiles)).toBe(codex)
    const shell = { ...claude, command: [] }
    expect(forRole(shell, 'implementation', profiles)).toBe(shell)
  })

  it('trims only for a role object, so a mistyped true keeps the full harness', () => {
    const typo = { ...profiles, 'claude-code': { env: { LEAN: '1' }, roles: { review: true } } }
    expect(forRole(claude, 'review', typo as unknown as LaneTools)).toBe(claude)
  })

  it('keeps the tool env it already had, and works on a Blank Slate launch', () => {
    const env = { HOME: '/home/u' }
    const blank = forWorkspace(
      { ...claude, env: { COLOR: 'x' } },
      '/home/u/.local/share/aico/blank-slate/w',
      env,
    )
    const spec = forRole(blank, 'implementation', profiles)
    expect(spec.command).toEqual([
      '/home/u/.local/lib/tether/scripts/aico-blank-slate',
      'claude-code',
      '--dangerously-skip-permissions',
      '--disallowedTools=A',
    ])
    expect(spec.env).toEqual({ COLOR: 'x', LEAN: '1' })
  })

  it('reaches the launch line as inline env and argv', () => {
    const line = launchLine(forRole(claude, 'implementation', profiles))
    expect(line).toContain(' LEAN=1 claude --dangerously-skip-permissions --disallowedTools=A')
  })
})

describe('shipped lane tools', () => {
  it('keeps the whole harness for coordinators and trims Artifact for lanes', () => {
    expect(forRole(claude, 'coordinator')).toBe(claude)
    for (const role of ['implementation', 'review', 'research', 'recon', 'hunting', 'other']) {
      const spec = forRole(claude, role)
      expect(spec.env?.CLAUDE_CODE_DISABLE_ARTIFACT).toBe('1')
      expect(spec.command.at(-1)).toMatch(/^--disallowedTools=.*ReportFindings/)
    }
  })

  it('keeps the tools a role used in the last week', () => {
    // implementation lanes scheduled wakeups; an "other" lane asked a question.
    expect(forRole(claude, 'implementation').command.at(-1)).not.toContain('ScheduleWakeup')
    expect(forRole(claude, 'other').command.at(-1)).not.toContain('AskUserQuestion')
  })
})
