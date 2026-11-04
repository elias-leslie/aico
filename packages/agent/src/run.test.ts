// The loop on pi-ai's faux provider: tools run, every row lands in agent.db, a refusal
// hands the same conversation to the next model, the test hook is off unless set, a
// model swap stops the run, and the guard blocks bash.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@aico/store'
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { refusalOf, swapOf } from './outcomes'
import type { RoleRules } from './rules'
import { HARNESS } from './rules'
import { runAgent } from './run'
import { credentialMarkers, guardBash, touchesCredentials } from './tools'
import { MIGRATIONS, openAgentDb, Transcript } from './transcript'

function setup(guardHook: string | null = null, firstApi = 'faux-openai') {
  const first = fauxProvider({
    provider: 'openai',
    api: firstApi,
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
  const run = (task: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
    runAgent({ rules, task, cwd, db, models, contextFiles: [], ...extra })
  return { first, second, cwd, db, run, rules }
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

  it('stops a swapped model before its tool calls run', async () => {
    const { first, cwd, run } = setup()
    first.setResponses([
      (): AssistantMessage => ({
        ...fauxAssistantMessage(fauxToolCall('write', { path: 'swapped.txt', content: 'x' })),
        responseModel: 'gpt-5-mini',
      }),
      fauxAssistantMessage('should not be asked'),
    ])
    const result = await run('task')
    expect(result.outcome).toMatchObject({ kind: 'model_swap', served: 'gpt-5-mini' })
    expect(existsSync(join(cwd, 'swapped.txt'))).toBe(false)
    expect(first.state.callCount).toBe(1)
  })

  it('never runs a model that speaks the Claude API, whatever the chain says', async () => {
    const { first, second, run } = setup(null, 'anthropic-messages')
    second.setResponses([fauxAssistantMessage('second model answered')])
    const result = await run('task')
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'opencode-go/deepseek-v4.1-flash' })
    expect(first.state.callCount).toBe(0)
  })

  it('finishes the run as an error when something throws mid-run', async () => {
    const { db, run, rules } = setup()
    const broken = {
      getModel: () => {
        throw new Error('provider list broke')
      },
    } as unknown as Parameters<typeof runAgent>[0]['models']
    const result = await run('task', { models: broken, rules })
    expect(result.outcome).toEqual({
      kind: 'error',
      model: 'codex/gpt-6.1-sol',
      detail: 'provider list broke',
    })
    const row = db.prepare('SELECT outcome FROM runs WHERE id = ?').get(result.runId)
    expect(row).toMatchObject({ outcome: 'error' })
  })

  it('keeps the result of a call that reads a credential path out of agent.db', async () => {
    const { first, cwd, db, run } = setup()
    writeFileSync(join(cwd, 'plain.txt'), 'plain words\n')
    // A stand-in agent dir: the test never touches Pi's real auth file.
    const agentDir = mkdtempSync(join(tmpdir(), 'aico-agent-pidir-'))
    const secret = join(agentDir, 'auth.json')
    writeFileSync(secret, '{"openai":{"access":"fake-token"}}\n')
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
    first.setResponses([
      fauxAssistantMessage([
        fauxToolCall('read', { path: secret }, { id: 'c-secret' }),
        fauxToolCall('read', { path: 'plain.txt' }, { id: 'c-plain' }),
      ]),
      fauxAssistantMessage('done'),
    ])
    const result = await run('task')
    const rows = db
      .prepare("SELECT content FROM messages WHERE run_id = ? AND role = 'toolResult' ORDER BY seq")
      .all(result.runId)
      .map((row) => JSON.parse(String(row.content)))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ withheld: expect.any(String), chars: expect.any(Number) })
    expect(JSON.stringify(rows)).not.toContain('fake-token')
    expect(JSON.stringify(rows[1])).toContain('plain words')
    vi.unstubAllEnvs()
  })
})

describe('credential paths', () => {
  const home = homedir()
  const markers = credentialMarkers([getAgentDir(), ...HARNESS.credential_paths], home)

  it('spots every spelling of a credential path, in any tool', () => {
    const cwd = join(home, 'work')
    expect(touchesCredentials({ path: '~/.pi/agent/auth.json' }, cwd, markers)).toBe(true)
    expect(touchesCredentials({ command: 'cat $HOME/.ssh/id_ed25519' }, cwd, markers)).toBe(true)
    const braced = ['cat $', '{HOME}/.codex/auth.json'].join('')
    expect(touchesCredentials({ command: braced }, cwd, markers)).toBe(true)
    expect(touchesCredentials({ path: '../.pi/agent/auth.json' }, cwd, markers)).toBe(true)
    expect(touchesCredentials({ path: 'src/index.ts' }, cwd, markers)).toBe(false)
    expect(touchesCredentials({ command: 'ls -la' }, cwd, markers)).toBe(false)
  })
})

describe('transcript', () => {
  it('keeps every tool call when a provider reuses call ids each turn', () => {
    const db = openAgentDb(':memory:')
    const transcript = new Transcript(db, 'r1', { role: 'r', cwd: '/', task: 't', chain: [] })
    transcript.toolStart('call_1', 'bash', { command: 'one' })
    transcript.toolEnd('call_1', false, 3)
    transcript.toolStart('call_1', 'bash', { command: 'two' })
    transcript.blocked('call_1', 'no')
    transcript.toolEnd('call_1', true, 5)
    const rows = db
      .prepare('SELECT seq, args, is_error, result_chars, blocked FROM tool_calls ORDER BY seq')
      .all()
    expect(rows).toEqual([
      { seq: 0, args: '{"command":"one"}', is_error: 0, result_chars: 3, blocked: null },
      { seq: 1, args: '{"command":"two"}', is_error: 1, result_chars: 5, blocked: 'no' },
    ])
  })

  it('migrates a first-version agent.db, keeping its tool calls', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aico-agent-db-')), 'agent.db')
    const old = openDatabase(path, MIGRATIONS.slice(0, 1))
    old.exec(
      "INSERT INTO runs (id, role, cwd, task, started_at) VALUES ('r', 'x', '/', 't', 'now')",
    )
    old.exec(
      "INSERT INTO tool_calls (run_id, call_id, name, args, started_at) VALUES ('r', 'a', 'read', '{}', '1'), ('r', 'b', 'bash', '{}', '2')",
    )
    old.close()
    const db = openAgentDb(path)
    expect(db.prepare('SELECT seq, call_id FROM tool_calls ORDER BY seq').all()).toEqual([
      { seq: 0, call_id: 'a' },
      { seq: 1, call_id: 'b' },
    ])
    db.close()
  })
})

/** A guard stand-in: run directly, as aico-hook is. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('guardBash', () => {
  it('fails closed when the hook fails or prints something unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-agent-guard-'))
    const failing = script(dir, 'failing', 'exit 3')
    const garbled = script(dir, 'garbled', 'cat >/dev/null; echo not-json')
    const allow = script(dir, 'allow', 'cat >/dev/null; echo "{}"')
    expect(await guardBash(failing, 'ls', dir, 'c1')).toMatch(/hook exited 3/)
    expect(await guardBash(garbled, 'ls', dir, 'c2')).toMatch(/unreadable/)
    expect(await guardBash(join(dir, 'missing'), 'ls', dir, 'c3')).toMatch(/refused/)
    expect(await guardBash(allow, 'ls', dir, 'c4')).toBeNull()
  })

  it('allows only {} or an explicit allow: ask, unknown answers and the legacy block refuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-agent-guard-'))
    const answer = (name: string, json: string) =>
      script(dir, name, `cat >/dev/null; echo '${json}'`)
    const said = (decision: string) =>
      `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${decision}"}}`
    expect(await guardBash(answer('allow', said('allow')), 'ls', dir, 'c1')).toBeNull()
    expect(await guardBash(answer('ask', said('ask')), 'ls', dir, 'c2')).toMatch(/refused/)
    expect(await guardBash(answer('odd', said('maybe')), 'ls', dir, 'c3')).toMatch(/refused/)
    expect(
      await guardBash(answer('legacy', '{"decision":"block","reason":"old"}'), 'ls', dir, 'c4'),
    ).toMatch(/block.*old.*refused/)
    expect(await guardBash(answer('list', '[]'), 'ls', dir, 'c5')).toMatch(/refused/)
  })

  it('kills the whole hook process group on timeout, grandchildren included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-agent-guard-'))
    const pidFile = join(dir, 'pid')
    // The grandchild keeps stdout open.
    const hook = script(dir, 'slow', `cat >/dev/null; sh -c 'echo $$ > ${pidFile}; exec sleep 30'`)
    const started = Date.now()
    expect(await guardBash(hook, 'ls', dir, 'c1', 300)).toMatch(/timeout/)
    expect(Date.now() - started).toBeLessThan(5_000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((done) => setTimeout(done, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it.skipIf(!existsSync(HARNESS.guard_hook))(
    'agrees with the installed guard (aico-hook)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'aico-agent-guard-'))
      expect(await guardBash(HARNESS.guard_hook, 'ls -la', dir, 'c1')).toBeNull()
      expect(await guardBash(HARNESS.guard_hook, 'git push origin main', dir, 'c2')).toMatch(
        /publication/i,
      )
    },
  )
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
    expect(refusalOf(error('HTTP 400: invalid safety settings'))).toBeNull()
    expect(refusalOf(error('upstream refusal to connect'))).toBeNull()
    expect(refusalOf(error('Error: see cyber_policy docs'))).toBeNull()
    expect(refusalOf(error('Provider failed', 'incomplete.safety'))?.category).toBe('safety')
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
