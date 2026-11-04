// fixtures/policy.json is the launch policy in the live context.db on 2026-11-03
// (loadPolicy output), so these rows are the ones `aico agent run` sees.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, type LaunchPolicy, openContext } from '@aico/context'
import { describe, expect, it } from 'vitest'
import policyData from './fixtures/policy.json' with { type: 'json' }
import {
  HARNESS,
  type Harness,
  loadRoleRules,
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

  it('refuses unknown models, unknown roles and roles whose egress it cannot enforce', () => {
    expect(refusal(rules('implementation', 'mystery-model-9')).reason).toBe('model_unknown')
    expect(refusal(rules('juggling')).reason).toBe('unknown_role')
    expect(refusal(rules('hunting')).reason).toBe('unenforceable')
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

describe('fail closed', () => {
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
})
