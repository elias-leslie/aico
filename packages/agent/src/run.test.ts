// The loop on pi-ai's faux provider: tools run, every row lands in agent.db, a refusal
// hands the same conversation to the next model, the test hook is off unless set, a
// model swap stops the run, and the guard blocks bash.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { refusalOf, swapOf } from './outcomes'
import type { RoleRules } from './rules'
import { runAgent } from './run'
import { guardBash } from './tools'
import { openAgentDb } from './transcript'

function setup(guardHook: string | null = null) {
  const first = fauxProvider({
    provider: 'openai',
    api: 'faux-openai',
    models: [{ id: 'gpt-6.1-sol', reasoning: true }],
  })
  const second = fauxProvider({
    provider: 'opencode-go',
    api: 'faux-opencode',
    models: [{ id: 'deepseek-v4.1-flash', reasoning: true }],
  })
  const models = createModels()
  models.setProvider(first.provider)
  models.setProvider(second.provider)
  const rules: RoleRules = {
    role: 'implementation',
    chain: [
      { id: 'codex/gpt-6.1-sol', piProvider: 'openai', piModel: 'gpt-6.1-sol', effort: 'high' },
      {
        id: 'opencode-go/deepseek-v4.1-flash',
        piProvider: 'opencode-go',
        piModel: 'deepseek-v4.1-flash',
        effort: 'high',
      },
    ],
    level: 'lean',
    tools: ['read', 'bash', 'edit', 'write'],
    guardHook,
    egress: 'host',
  }
  const cwd = mkdtempSync(join(tmpdir(), 'aico-agent-run-'))
  const db = openAgentDb(':memory:')
  const run = (task: string, extra: { testRefuseAt?: number } = {}) =>
    runAgent({ rules, task, cwd, db, models, contextFiles: [], ...extra })
  return { first, second, cwd, db, run }
}

const texts = (context: TranscriptContext) => JSON.stringify(context.messages)
const refused = (code: string) =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: `${code}: blocked` })

describe('runAgent', () => {
  it('runs tools in the cwd and writes every turn, tool call and token count to agent.db', async () => {
    const { first, cwd, db, run } = setup()
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'hello.txt', content: 'hi\n' })),
      fauxAssistantMessage('wrote hello.txt'),
    ])
    const result = await run('write hello.txt')
    expect(result.outcome).toMatchObject({
      kind: 'done',
      model: 'codex/gpt-6.1-sol',
      text: 'wrote hello.txt',
    })
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi\n')
    expect(result.toolCalls).toBe(1)

    const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(result.runId) as Record<
      string,
      unknown
    >
    expect(runRow).toMatchObject({ outcome: 'done', tool_calls: 1, role: 'implementation' })
    expect(runRow.input).toBe(result.tokens.input)
    const roles = db
      .prepare('SELECT role FROM messages WHERE run_id = ? ORDER BY seq')
      .all(result.runId)
    expect(roles.map((row) => row.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    const assistant = db
      .prepare(
        "SELECT model, stop_reason, input, output FROM messages WHERE run_id = ? AND role = 'assistant'",
      )
      .all(result.runId)
    expect(assistant[0]).toMatchObject({ model: 'codex/gpt-6.1-sol', stop_reason: 'stop' })
    expect(typeof assistant[0]?.output).toBe('number')
    const call = db
      .prepare('SELECT name, is_error, args FROM tool_calls WHERE run_id = ?')
      .get(result.runId)
    expect(call).toMatchObject({ name: 'write', is_error: 0 })
  })

  it('hands a refused conversation to the next model with everything before the refusal', async () => {
    const { first, second, db, run } = setup()
    let seen = ''
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo marker-41' })),
      refused('cyber_policy'),
    ])
    second.setResponses([
      (context) => {
        seen = texts(context)
        return fauxAssistantMessage('finished after handoff')
      },
    ])
    const result = await run('do the task')
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'opencode-go/deepseek-v4.1-flash' })
    expect(seen).toContain('do the task')
    expect(seen).toContain('marker-41')
    expect(seen).toContain('[handoff] codex/gpt-6.1-sol stopped with a cyber refusal')
    expect(seen).not.toContain('cyber_policy: blocked')
    expect(result.handoffs).toHaveLength(1)
    const [handoff] = result.handoffs
    expect(handoff).toMatchObject({
      from: 'codex/gpt-6.1-sol',
      to: 'opencode-go/deepseek-v4.1-flash',
      reason: 'cyber',
    })
    expect(handoff?.context_messages).toBe(3)
    expect(handoff?.handoff_tokens).toBeGreaterThan(0)
    expect(handoff?.handoff_tokens).toBeLessThan(60)
    expect(handoff?.context_tokens).toBeGreaterThan(0)
    const row = db.prepare('SELECT * FROM handoffs WHERE run_id = ?').get(result.runId)
    expect(row).toMatchObject({ reason: 'cyber', context_messages: 3 })
    const outcomes = db
      .prepare('SELECT outcome FROM messages WHERE run_id = ? AND outcome IS NOT NULL')
      .all(result.runId)
    expect(outcomes.map((r) => JSON.parse(String(r.outcome)).kind)).toEqual(['refusal'])
  })

  it('injects a refusal only when the test hook is set', async () => {
    const off = setup()
    off.first.setResponses([fauxAssistantMessage('first model answered')])
    expect((await off.run('task')).outcome).toMatchObject({
      kind: 'done',
      model: 'codex/gpt-6.1-sol',
    })

    const on = setup()
    on.first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'true' })),
      fauxAssistantMessage('x'),
    ])
    on.second.setResponses([fauxAssistantMessage('second model answered')])
    const result = await on.run('task', { testRefuseAt: 2 })
    expect(on.first.state.callCount).toBe(1)
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'opencode-go/deepseek-v4.1-flash' })
    expect(result.handoffs[0]?.context_messages).toBe(3)
  })

  it('ends with model_refused when the last model in the chain refuses', async () => {
    const { first, second, run } = setup()
    first.setResponses([refused('cyberPolicy')])
    second.setResponses([refused('too_many_denials')])
    const result = await run('task')
    expect(result.outcome).toMatchObject({
      kind: 'model_refused',
      model: 'opencode-go/deepseek-v4.1-flash',
    })
    expect(result.handoffs).toHaveLength(1)
  })

  it('stops on a model swap', async () => {
    const { first, run } = setup()
    first.setResponses([
      (): AssistantMessage => ({
        ...fauxAssistantMessage('hi'),
        responseModel: 'gpt-5-mini-2026-01-01',
      }),
    ])
    expect((await run('task')).outcome).toEqual({
      kind: 'model_swap',
      requested: 'gpt-6.1-sol',
      served: 'gpt-5-mini-2026-01-01',
    })
  })

  it('reports a plain provider error as an error, not a refusal', async () => {
    const { first, second, run } = setup()
    first.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 500: upstream' }),
    ])
    const result = await run('task')
    expect(result.outcome).toMatchObject({ kind: 'error', detail: 'HTTP 500: upstream' })
    expect(second.state.callCount).toBe(0)
  })

  it('runs every bash call through the guard and keeps blocked calls from running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-agent-guard-'))
    const hook = join(dir, 'guard')
    writeFileSync(
      hook,
      '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no publishing"}}\'\n',
    )
    chmodSync(hook, 0o755)
    const { first, cwd, db, run } = setup(hook)
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'touch ran' })),
      fauxAssistantMessage('ok'),
    ])
    const result = await run('task')
    expect(existsSync(join(cwd, 'ran'))).toBe(false)
    const call = db
      .prepare('SELECT blocked, is_error FROM tool_calls WHERE run_id = ?')
      .get(result.runId)
    expect(call).toMatchObject({ blocked: 'no publishing', is_error: 1 })
  })
})

describe('guardBash', () => {
  it('fails closed when the hook fails or prints something unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-agent-guard-'))
    const failing = join(dir, 'failing')
    writeFileSync(failing, 'exit 3\n')
    const garbled = join(dir, 'garbled')
    writeFileSync(garbled, 'cat >/dev/null; echo not-json\n')
    const allow = join(dir, 'allow')
    writeFileSync(allow, 'cat >/dev/null; echo "{}"\n')
    expect(await guardBash(failing, 'ls', dir, 'c1')).toMatch(/hook exited 3/)
    expect(await guardBash(garbled, 'ls', dir, 'c2')).toMatch(/unreadable/)
    expect(await guardBash(join(dir, 'missing'), 'ls', dir, 'c3')).toMatch(/refused/)
    expect(await guardBash(allow, 'ls', dir, 'c4')).toBeNull()
  })
})

describe('outcomes', () => {
  const error = (errorMessage: string, rawStopReason?: string) => ({
    ...fauxAssistantMessage('', { stopReason: 'error', errorMessage }),
    ...(rawStopReason && { rawStopReason }),
  })

  it('reads refusal codes however they are spelled', () => {
    expect(refusalOf(error('cyber_policy: no'))?.category).toBe('cyber')
    expect(refusalOf(error('Error Code cyberPolicy: no'))?.category).toBe('cyber')
    expect(refusalOf(error('misalignment_policy_violation'))?.category).toBe('misalignment')
    expect(
      refusalOf(error('Response incomplete: content_filter', 'incomplete.content_filter'))
        ?.category,
    ).toBe('content_filter')
    expect(refusalOf(error('HTTP 429: rate limited'))).toBeNull()
    expect(refusalOf(fauxAssistantMessage('cyber_policy is a phrase'))).toBeNull()
  })

  it('treats a dated or prefixed id of the same model as the same model', () => {
    const served = (responseModel: string) => ({ ...fauxAssistantMessage('x'), responseModel })
    expect(swapOf(served('gpt-6.1-sol-2026-10-01'), 'gpt-6.1-sol')).toBeNull()
    expect(swapOf(served('openai/gpt-6.1-sol'), 'gpt-6.1-sol')).toBeNull()
    expect(swapOf(fauxAssistantMessage('x'), 'gpt-6.1-sol')).toBeNull()
    expect(swapOf(served('gpt-6-mini'), 'gpt-6.1-sol')).toMatchObject({
      kind: 'model_swap',
      served: 'gpt-6-mini',
    })
  })
})
