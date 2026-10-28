import { describe, expect, it } from 'vitest'
import { parseRootCreate, rootRequestDigest } from '../lifecycle/root-control'
import { registerBuiltinTuis } from '../lifecycle/testing'

registerBuiltinTuis()

const base = {
  requestId: 'req-1',
  projectId: 'sample-app',
  projectRoot: '/tmp/proj',
  initialPrompt: 'Go.',
  role: 'lead',
  workRole: 'implementation',
}

describe('agent-hub root requests', () => {
  it('needs an agent slug for agent-hub and refuses it for other tools', () => {
    expect(parseRootCreate({ ...base, tool: 'agent-hub', agentSlug: 'chat' })).toMatchObject({
      tool: 'agent-hub',
      agentSlug: 'chat',
    })
    expect(parseRootCreate({ ...base, tool: 'agent-hub' })).toBeNull()
    expect(parseRootCreate({ ...base, tool: 'agent-hub', agentSlug: 'bad slug' })).toBeNull()
    expect(parseRootCreate({ ...base, tool: 'codex', agentSlug: 'chat' })).toBeNull()
    expect(
      parseRootCreate({ ...base, tool: 'agent-hub', agentSlug: 'chat', model: 'm' }),
    ).not.toBeNull()
    for (const extra of [
      { resumeSessionId: '00000000-0000-4000-8000-000000000001' },
      { reasoningEffort: 'high' },
      { daybreak: true },
    ])
      expect(
        parseRootCreate({ ...base, tool: 'agent-hub', agentSlug: 'chat', ...extra }),
      ).toBeNull()
  })

  it('leaves the digest of existing tools unchanged and covers the agent for agent-hub', () => {
    const codex = parseRootCreate({ ...base, tool: 'codex' })
    if (!codex) throw new Error('codex request should parse')
    expect(rootRequestDigest(codex)).toBe(rootRequestDigest({ ...codex, agentSlug: null }))
    const a = parseRootCreate({ ...base, tool: 'agent-hub', agentSlug: 'chat' })
    const b = parseRootCreate({ ...base, tool: 'agent-hub', agentSlug: 'explorer' })
    if (!a || !b) throw new Error('hub requests should parse')
    expect(rootRequestDigest(a)).not.toBe(rootRequestDigest(b))
  })
})
