// fixtures/policy.json is the launch policy in the live context.db on 2026-11-03
// (loadPolicy output), so these rows are the ones `aico agent run` sees.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, type Facts, type LaunchPolicy, openContext } from '@aico/context'
import { describe, expect, it } from 'vitest'
import policyData from './fixtures/policy.json' with { type: 'json' }
import {
  HARNESS,
  type Harness,
  loadRoleRules,
  projectFor,
  type Refused,
  type RoleRules,
  readPolicy,
  roleRules,
} from './rules'

const policy = policyData as unknown as LaunchPolicy
const catalog = new Catalog()
const dir = mkdtempSync(join(tmpdir(), 'aico-agent-rules-'))
const hook = join(dir, 'guard')
writeFileSync(hook, '#!/bin/sh\necho "{}"\n')
const harness: Harness = { ...HARNESS, guard_hook: hook }

const rules = (role: string, model?: string) =>
  roleRules(policy, catalog, harness, { role, ...(model && { model }) })
const refusal = (result: RoleRules | Refused) => {
  if (!('kind' in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result
}

describe('role rules', () => {
  it('builds the implementation chain from route(): codex first, then the pi rows and alternates', () => {
    const result = rules('implementation') as RoleRules
    expect(
      result.chain.map((entry) => [entry.id, entry.piProvider, entry.piModel, entry.effort]),
    ).toEqual([
      ['codex/gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'xhigh'],
      ['opencode-go/deepseek-v4.1-flash', 'opencode-go', 'deepseek-v4.1-flash', 'high'],
      ['opencode-go/glm-5.3', 'opencode-go', 'glm-5.3', 'high'],
    ])
    expect(result.tools).toEqual(['read', 'bash', 'edit', 'write'])
    expect(result.guardHook).toBe(hook)
  })

  it('puts an allowed --model first and keeps the rest of the chain', () => {
    const result = rules('implementation', 'opencode-go/glm-5.3') as RoleRules
    expect(result.chain.map((entry) => entry.id)).toEqual([
      'opencode-go/glm-5.3',
      'codex/gpt-6.1-sol',
      'opencode-go/deepseek-v4.1-flash',
    ])
  })

  it('gives review the read-only level', () => {
    expect((rules('review') as RoleRules).tools).toEqual(['read'])
  })

  it('refuses a denied model with the deny row reason (hunting --model fable)', () => {
    const result = refusal(rules('hunting', 'fable'))
    expect(result.reason).toBe('model_denied')
    expect(result.detail).toContain('Claude never for active hunting or recon')
  })

  it('never runs Claude, by provider or by name', () => {
    expect(refusal(rules('implementation', 'fable')).reason).toBe('provider_not_allowed')
    expect(refusal(rules('implementation', 'opencode-go/claude-haiku-5-5')).reason).toMatch(
      /provider_not_allowed|model_unknown/,
    )
    for (const entry of (rules('implementation') as RoleRules).chain)
      expect(entry.id).not.toMatch(/claude|fable/)
  })

  it('refuses unknown models and unknown roles', () => {
    expect(refusal(rules('implementation', 'mystery-model-9')).reason).toBe('model_unknown')
    expect(refusal(rules('juggling')).reason).toBe('unknown_role')
  })

  it('refuses when the guard the role needs is missing', () => {
    const result = roleRules(
      policy,
      catalog,
      { ...harness, guard_hook: join(dir, 'missing') },
      { role: 'implementation' },
    )
    expect(refusal(result).reason).toBe('unenforceable')
  })
})

describe('hunting role', () => {
  // A harness whose contain command works everywhere, so these tests do not depend on user namespaces.
  const contained: Harness = { ...harness, contain_command: ['env'] }
  const hunting = (model?: string, with_: Harness = contained) =>
    roleRules(policy, catalog, with_, { role: 'hunting', ...(model && { model }) })

  it('runs on non-Claude models only, inside the contained egress profile', () => {
    const result = hunting() as RoleRules
    expect(result.chain.map((entry) => entry.id)).toEqual([
      'codex/gpt-6-sol',
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/glm-5.3',
      'opencode-go/glm-5.3-flash',
    ])
    expect(result).toMatchObject({
      egress: 'contained',
      hosts: ['api.openai.com', 'opencode.ai'],
      contain: {
        command: ['env'],
        hide: harness.contain_hide,
        unsetEnv: harness.contain_unset_env,
      },
    })
    expect((rules('implementation') as RoleRules).hosts).toBeNull()
  })

  it('refuses any Claude model: by the deny row, by provider, or by name', () => {
    expect(refusal(hunting('fable')).reason).toBe('model_denied')
    expect(refusal(hunting('opencode-go/claude-haiku-5-5')).reason).toMatch(
      /model_denied|provider_not_allowed|model_unknown/,
    )
    // With the deny row gone, the harness still never runs Claude.
    const open = { ...policy, deny: [] }
    expect(
      refusal(roleRules(open, catalog, contained, { role: 'hunting', model: 'fable' })).reason,
    ).toBe('provider_not_allowed')
  })

  it('fails closed when its egress profile is missing or cannot be enforced here', () => {
    const missing = { ...contained, egress_profiles: { host: ['*'] } } as unknown as Harness
    expect(refusal(hunting(undefined, missing)).detail).toMatch(/egress profile 'contained'/)
    const broken = { ...contained, contain_command: [join(dir, 'no-such-command')] }
    const result = refusal(hunting(undefined, broken))
    expect(result.reason).toBe('unenforceable')
    expect(result.detail).toMatch(/runs its tools contained/)
  })
})

describe('projects', () => {
  const projects = [
    { id: 'home', root: '/home/someone' },
    { id: 'aico', root: '/srv/workspaces/projects/aico' },
    { id: 'aico-web', root: '/srv/workspaces/projects/aico/packages/web' },
  ]

  it('finds the deepest registered root that holds the working folder', () => {
    expect(projectFor(projects, '/srv/workspaces/projects/aico/packages/web/src')).toBe('aico-web')
    expect(projectFor(projects, '/srv/workspaces/projects/aico')).toBe('aico')
    expect(projectFor(projects, '/srv/workspaces/projects/aico-old')).toBeUndefined()
    expect(projectFor(projects, '/tmp')).toBeUndefined()
  })

  // A copy of the live policy whose implementation job has a deny row for one project.
  const scoped: LaunchPolicy = {
    ...policy,
    providers: {
      ...policy.providers,
      codex: {
        name: 'codex',
        label: 'Codex',
        tools: [],
        catalogProviders: ['codex'],
        nameTokens: [],
        why: 'test',
      } as LaunchPolicy['providers'][string],
    },
    deny: [
      ...policy.deny,
      {
        provider: 'codex',
        reason: 'no codex in secret-project',
        source: 'test',
        jobs: ['implementation'],
        projects: ['secret-project'],
      } as LaunchPolicy['deny'][number],
    ],
  }

  it('refuses when the role has project deny rows and the project is unknown', () => {
    const result = refusal(roleRules(scoped, catalog, harness, { role: 'implementation' }))
    expect(result.reason).toBe('project_unknown')
    expect(result.detail).toContain('secret-project')
  })

  it('applies the project deny row once the project is known', () => {
    const inside = roleRules(scoped, catalog, harness, {
      role: 'implementation',
      project: 'secret-project',
    }) as RoleRules
    expect(inside.chain.map((entry) => entry.id)).not.toContain('codex/gpt-6.1-sol')
    const elsewhere = roleRules(scoped, catalog, harness, {
      role: 'implementation',
      project: 'aico',
    }) as RoleRules
    expect(elsewhere.chain[0]?.id).toBe('codex/gpt-6.1-sol')
  })
})

describe('fail closed', () => {
  it('refuses when the launch policy has no Claude provider entry', () => {
    const { claude: _, ...providers } = policy.providers
    const result = roleRules({ ...policy, providers }, catalog, harness, {
      role: 'implementation',
    })
    expect(refusal(result).reason).toBe('rules_unreadable')
    expect(refusal(result).detail).toContain("no 'claude' provider entry")
  })

  it('refuses when context.db is missing', () => {
    const result = loadRoleRules(
      join(dir, 'nope', 'context.db'),
      { role: 'implementation' },
      harness,
    )
    expect(refusal(result).reason).toBe('rules_unreadable')
  })

  it('refuses when context.db is not a database', () => {
    const path = join(dir, 'garbage.db')
    writeFileSync(path, 'this is not sqlite '.repeat(100))
    const result = readPolicy(path) as Refused
    expect(result.reason).toBe('rules_unreadable')
    expect(result.detail).toContain('could not be read')
  })

  it('refuses when context.db has no launch policy', () => {
    const path = join(dir, 'empty.db')
    openContext(path).close()
    const result = loadRoleRules(path, { role: 'implementation' }, harness) as Refused
    expect(result.reason).toBe('rules_unreadable')
    expect(result.detail).toContain('no launch policy')
  })

  describe('used-up subscriptions', () => {
    const now = '2026-11-06T20:00:00.000Z'
    const reading = (provider: string, usedPercent: number, resetsAt: string) => ({
      provider,
      window_minutes: 10080,
      observed_at: '2026-11-06T19:55:00.000Z',
      used_percent: usedPercent,
      resets_at: resetsAt,
      source: 'test',
    })
    const facts = (...readings: ReturnType<typeof reading>[]): Facts => ({
      readings,
      credits: {},
      refusals: [],
    })
    const withUsage = (given: Facts) =>
      roleRules(policy, catalog, harness, {
        role: 'implementation',
        usage: { facts: given, now },
      })

    it('skips the models of a used-up subscription and says which, with when it frees up', () => {
      const result = withUsage(
        facts(
          reading('opencode-go', 100, '2026-11-08T19:00:00.000Z'),
          reading('codex', 10, '2026-11-11T10:00:00.000Z'),
        ),
      ) as RoleRules
      expect(result.chain.map((entry) => entry.id)).toEqual(['codex/gpt-6.1-sol'])
      expect(result.skipped).toEqual([
        {
          id: 'opencode-go/deepseek-v4.1-flash',
          provider: 'opencode-go',
          until: '2026-11-08T19:00:00.000Z',
        },
        { id: 'opencode-go/glm-5.3', provider: 'opencode-go', until: '2026-11-08T19:00:00.000Z' },
      ])
    })

    it('keeps the whole chain and skips nothing when every subscription has room', () => {
      const result = withUsage(
        facts(
          reading('opencode-go', 20, '2026-11-08T19:00:00.000Z'),
          reading('codex', 10, '2026-11-11T10:00:00.000Z'),
        ),
      ) as RoleRules
      expect(result.chain).toHaveLength(3)
      expect(result.skipped).toBeUndefined()
    })

    it('treats a provider with no readings as unknown, not used up', () => {
      expect((withUsage(facts()) as RoleRules).chain).toHaveLength(3)
    })

    it('refuses naming every reset time when all of them are used up', () => {
      const result = refusal(
        withUsage(
          facts(
            reading('opencode-go', 100, '2026-11-08T19:00:00.000Z'),
            reading('codex', 100, '2026-11-11T10:35:00.000Z'),
          ),
        ),
      )
      expect(result.reason).toBe('used_up')
      expect(result.detail).toMatch(/^every model role 'implementation' may run is used up: /)
      expect(result.detail).toContain('codex/gpt-6.1-sol until Nov 11')
      expect(result.detail).toContain('opencode-go/deepseek-v4.1-flash until Nov 8')
      expect(result.detail).toContain('opencode-go/glm-5.3 until Nov 8')
    })

    it('keeps an explicit --model even when its subscription is used up', () => {
      const result = roleRules(policy, catalog, harness, {
        role: 'implementation',
        model: 'opencode-go/glm-5.3',
        usage: { facts: facts(reading('opencode-go', 100, '2026-11-08T19:00:00.000Z')), now },
      }) as RoleRules
      expect(result.chain.map((entry) => entry.id)).toEqual([
        'opencode-go/glm-5.3',
        'codex/gpt-6.1-sol',
      ])
      expect(result.skipped?.map((entry) => entry.id)).toEqual(['opencode-go/deepseek-v4.1-flash'])
    })
  })
})
