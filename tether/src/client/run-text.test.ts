import { describe, expect, it } from 'vitest'
import type { RunMember } from './run-text'
import { childAgents, executorTool } from './run-text'

const member = (extra: Partial<RunMember>): RunMember =>
  ({ kind: 'step', group: 'working', ...extra }) as RunMember

describe('child agents of a workflow run', () => {
  it('names the tool of a step by its executor', () => {
    expect(executorTool('pi')).toBe('pi')
    expect(executorTool('codex')).toBe('codex')
    expect(executorTool('claude_code')).toBe('claude-code')
    expect(executorTool('agent_hub')).toBe('agent-hub')
    expect(executorTool(undefined)).toBe('agent-hub')
    expect(executorTool('something-new')).toBe('agent-hub')
  })

  it('lists steps that are working or waiting for the owner, and nothing else', () => {
    const items = [
      member({ kind: 'run', group: 'needs-you', id: 'run' }),
      member({ id: 'working', group: 'working' }),
      member({ id: 'waiting', group: 'needs-you' }),
      member({ id: 'pending', group: 'idle' }),
      member({ id: 'done', group: 'idle' }),
      member({ id: 'failed', group: 'no-status' }),
    ]
    expect(childAgents(items).map((m) => m.id)).toEqual(['working', 'waiting'])
  })
})
