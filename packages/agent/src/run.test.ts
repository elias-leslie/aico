// The loop on pi-ai's faux provider: tools run, every row lands in agent.db, a refusal
// hands the same conversation to the next model, the test hook is off unless set, a
// model swap stops the run, and the guard blocks bash.

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
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
import {
  type Contain,
  credentialMarkers,
  guardBash,
  touchesCredentials,
  writeRefusal,
} from './tools'
import { findRun, MIGRATIONS, openAgentDb, Transcript } from './transcript'

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
    hosts: null,
    contain: null,
  }
  const cwd = mkdtempSync(join(tmpdir(), 'aico-agent-run-'))
  const db = openAgentDb(':memory:')
  const run = async (task: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
    ...(await runAgent({ rules, task, cwd, db, models, contextFiles: [], ...extra })),
    models,
  })
  return { first, second, cwd, db, run, rules, models }
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

  it('hands a turn that fails with a provider error to the next model, and logs who ran each turn', async () => {
    const { first, second, db, run } = setup()
    let seen = ''
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo marker-77' })),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 500: upstream' }),
    ])
    second.setResponses([
      (context) => {
        seen = texts(context)
        return fauxAssistantMessage('second model finished the turn')
      },
    ])
    const lines: string[] = []
    const result = await run('task', { log: (line) => lines.push(line) })
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'opencode-go/deepseek-v4.1-flash' })
    // The same turn, no handoff note: the conversation goes on from the tool result.
    expect(seen).toContain('marker-77')
    expect(seen).not.toContain('[handoff]')
    expect(seen).not.toContain('HTTP 500')
    expect(result.turns).toEqual([
      { turn: 1, model: 'codex/gpt-6.1-sol', stop: expect.any(String) },
      { turn: 2, model: 'codex/gpt-6.1-sol', stop: 'error' },
      { turn: 3, model: 'opencode-go/deepseek-v4.1-flash', stop: 'stop' },
    ])
    expect(result.handoffs).toEqual([
      expect.objectContaining({ reason: 'provider_error', handoff_tokens: 0 }),
    ])
    expect(lines.join('\n')).toMatch(
      /provider error on codex\/gpt-6.1-sol \(HTTP 500: upstream\); opencode-go\/deepseek-v4.1-flash takes the turn/,
    )
    const models = db
      .prepare(
        "SELECT turn, model FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY seq",
      )
      .all(result.runId)
    expect(models.at(-1)).toEqual({ turn: 3, model: 'opencode-go/deepseek-v4.1-flash' })
  })

  it('ends with the error when the last model in the chain fails too', async () => {
    const { first, second, run } = setup()
    first.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 500: upstream' }),
    ])
    second.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'connect ECONNREFUSED' }),
    ])
    const result = await run('task')
    expect(result.outcome).toMatchObject({ kind: 'error', detail: 'connect ECONNREFUSED' })
    expect(result.handoffs).toHaveLength(1)
  })

  it('keeps a failed tool call on the same model: a tool error is not a provider error', async () => {
    const { first, second, run } = setup()
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path: 'missing.txt' })),
      fauxAssistantMessage('the file is missing'),
    ])
    const result = await run('task')
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'codex/gpt-6.1-sol' })
    expect(result.handoffs).toEqual([])
    expect(second.state.callCount).toBe(0)
  })

  it('sends --test-unreachable model to an address that refuses connections', async () => {
    const { first, second, run } = setup()
    const asked: string[] = []
    first.setResponses([
      (_context, _options, _state, model) => {
        asked.push(model.baseUrl)
        return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' })
      },
    ])
    second.setResponses([fauxAssistantMessage('took over')])
    const result = await run('task', { testUnreachable: 'codex/gpt-6.1-sol' })
    expect(asked).toEqual(['http://127.0.0.1:9/v1'])
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'opencode-go/deepseek-v4.1-flash' })
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

describe('egress profile', () => {
  /** The same models, with `provider`'s endpoint moved to `baseUrl`. */
  const movedTo = (
    models: ReturnType<typeof setup>['models'],
    provider: string,
    baseUrl: string,
  ) => {
    const moved = Object.create(models) as typeof models
    moved.getModel = ((p: string, id: string) => {
      const model = models.getModel(p, id)
      return model && p === provider ? { ...model, baseUrl } : model
    }) as typeof models.getModel
    return moved
  }

  it('skips a chain model whose host is outside the profile; the next one inside runs', async () => {
    const { second, rules, run, models } = setup()
    second.setResponses([fauxAssistantMessage('inside')])
    const lines: string[] = []
    const result = await run('task', {
      rules: { ...rules, egress: 'contained', hosts: ['localhost'] },
      models: movedTo(models, 'openai', 'https://api.example.com/v1'),
      log: (line) => lines.push(line),
    })
    expect(result.outcome).toMatchObject({ kind: 'done', text: 'inside' })
    expect(lines).toContain(
      "skip codex/gpt-6.1-sol: api.example.com is outside egress profile 'contained'",
    )
  })

  it('refuses the run when no chain model is inside the profile', async () => {
    const { first, rules, run } = setup()
    const result = await run('task', {
      rules: { ...rules, egress: 'contained', hosts: ['api.openai.com', 'opencode.ai'] },
    })
    expect(result.outcome).toMatchObject({ kind: 'refused', reason: 'egress_denied' })
    expect(first.state.callCount).toBe(0)
  })
})

describe('contained tools', () => {
  const contain: Contain = {
    command: HARNESS.contain_command,
    hide: HARNESS.contain_hide,
    unsetEnv: HARNESS.contain_unset_env,
  }
  const containedRules = (rules: RoleRules): RoleRules => ({
    ...rules,
    egress: 'contained',
    hosts: ['localhost'],
    contain,
  })
  const listen = (path: string) =>
    new Promise<Server>((done) => {
      const server = createServer()
      server.listen(path, () => done(server))
    })
  const results = (db: ReturnType<typeof setup>['db'], runId: string) =>
    db
      .prepare("SELECT content FROM messages WHERE run_id = ? AND role = 'toolResult' ORDER BY seq")
      .all(runId)
      .map((row) => JSON.stringify(JSON.parse(String(row.content))))

  // No skip: a host where the sandbox does not start fails here (and the role is refused there).
  it('the contain command starts on this host', () => {
    const [file, ...args] = HARNESS.contain_command
    expect(spawnSync(file as string, [...args, 'true'], { stdio: 'ignore' }).status).toBe(0)
  })

  it("runs a contained role's bash with only loopback, no user bus, Tether socket or tmux, and a read-only system", async () => {
    const { first, rules, run, db, cwd } = setup()
    mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true })
    const socket = join(cwd, 'tether.sock')
    const server = await listen(socket)
    const connect = `python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).connect(sys.argv[1])' ${socket}`
    // Outside the sandbox the socket answers, so a refusal inside means the sandbox.
    expect(spawnSync('bash', ['-c', connect]).status).toBe(0)
    vi.stubEnv('TETHER_SOCKET', socket)
    const tried = (label: string, command: string) =>
      `if ${command} >/dev/null 2>&1; then echo "${label} reached"; else echo "${label} refused"; fi`
    const script = [
      "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '",
      'echo "env ${TETHER_SOCKET:-none} ${XDG_RUNTIME_DIR:-none} ${DBUS_SESSION_BUS_ADDRESS:-none}"',
      tried('systemctl', 'systemctl --user show-environment'),
      tried('bus', `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user show-environment`),
      tried('tether', connect),
      tried('tmux', 'tmux ls'),
      tried('home', 'touch ~/.aico-contained-probe'),
      tried('hooks', 'touch .git/hooks/pre-commit'),
      tried('folder', 'touch inside.txt'),
    ].join('\n')
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: script })),
      fauxAssistantMessage('checked'),
    ])
    try {
      const result = await run('task', { rules: containedRules(rules) })
      expect(result.outcome.kind).toBe('done')
      const text = JSON.parse(results(db, result.runId)[0] as string)[0].text as string
      expect(text.split('\n')).toEqual([
        'lo',
        'env none none none',
        'systemctl refused',
        'bus refused',
        'tether refused',
        'tmux refused',
        'home refused',
        'hooks refused',
        'folder reached',
        '',
      ])
      expect(existsSync(join(homedir(), '.aico-contained-probe'))).toBe(false)
      expect(existsSync(join(cwd, 'inside.txt'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      server.close()
    }
  })

  it("keeps a contained role's write and edit inside the working folder and out of .git", async () => {
    const { first, rules, run, cwd } = setup()
    const outside = mkdtempSync(join(tmpdir(), 'aico-agent-outside-'))
    writeFileSync(join(outside, 'kept.txt'), 'original\n')
    symlinkSync(outside, join(cwd, 'link'))
    mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true })
    const unit = join(homedir(), '.config', 'systemd', 'user', 'aico-contained-probe.service')
    first.setResponses([
      fauxAssistantMessage([
        fauxToolCall('write', { path: join(outside, 'new.txt'), content: 'x' }),
        fauxToolCall('write', { path: '../escape.txt', content: 'x' }),
        fauxToolCall('write', { path: 'link/through.txt', content: 'x' }),
        fauxToolCall('write', { path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' }),
        fauxToolCall('write', { path: unit, content: '[Service]\n' }),
        fauxToolCall('edit', {
          path: join(outside, 'kept.txt'),
          edits: [{ oldText: 'original', newText: 'changed' }],
        }),
        fauxToolCall('write', { path: 'sub/ok.txt', content: 'fine' }),
      ]),
      fauxAssistantMessage('done'),
    ])
    try {
      const result = await run('task', { rules: containedRules(rules) })
      expect(result.outcome.kind).toBe('done')
      expect(existsSync(join(outside, 'new.txt'))).toBe(false)
      expect(existsSync(join(cwd, '..', 'escape.txt'))).toBe(false)
      expect(existsSync(join(outside, 'through.txt'))).toBe(false)
      expect(existsSync(join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false)
      expect(existsSync(unit)).toBe(false)
      expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('original\n')
      expect(readFileSync(join(cwd, 'sub', 'ok.txt'), 'utf8')).toBe('fine')
    } finally {
      rmSync(unit, { force: true })
    }
  })

  it('refuses paths outside the folder or in .git, through symlinks too', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'aico-agent-refusal-'))
    symlinkSync('/etc', join(cwd, 'etc'))
    expect(writeRefusal(cwd, join(cwd, 'a', 'b.txt'))).toBeNull()
    expect(writeRefusal(cwd, join(cwd, 'etc', 'passwd'))).toMatch(/outside the working folder/)
    expect(writeRefusal(cwd, join(cwd, 'x', '.git', 'config'))).toMatch(/inside a .git folder/)
    expect(writeRefusal(cwd, join(homedir(), '.bashrc'))).toMatch(/outside/)
  })
})

describe('resume and branch', () => {
  it('resumes a run from agent.db: the next prompt sees the whole conversation', async () => {
    const { first, db, run, rules, cwd } = setup()
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo marker-12' })),
      fauxAssistantMessage('first answer'),
    ])
    const one = await run('first task')
    let seen = ''
    first.appendResponses([
      (context) => {
        seen = texts(context)
        return fauxAssistantMessage('second answer')
      },
    ])
    const stored = findRun(db, one.runId.slice(0, 8))
    const two = await runAgent({
      rules,
      task: 'second task',
      cwd,
      db,
      models: one.models,
      contextFiles: [],
      resume: stored,
    })
    expect(two.runId).toBe(one.runId)
    expect(two.outcome).toMatchObject({ kind: 'done', text: 'second answer' })
    for (const text of ['first task', 'marker-12', 'first answer', 'second task'])
      expect(seen).toContain(text)
    expect(two.turns).toEqual([{ turn: 3, model: 'codex/gpt-6.1-sol', stop: 'stop' }])
    const row = db
      .prepare('SELECT outcome, tool_calls, output FROM runs WHERE id = ?')
      .get(one.runId)
    expect(row).toMatchObject({ outcome: 'done', tool_calls: 1 })
    expect(Number(row?.output)).toBe(one.tokens.output + two.tokens.output)
    const turns = db
      .prepare('SELECT role, turn FROM messages WHERE run_id = ? ORDER BY seq')
      .all(one.runId)
      .map((r) => `${r.role}:${r.turn}`)
    expect(turns).toEqual([
      'user:1',
      'assistant:1',
      'toolResult:1',
      'assistant:2',
      'user:3',
      'assistant:3',
    ])
  })

  it('resumes a run whose last turn failed without a new prompt', async () => {
    const { first, second, db, run, rules, cwd } = setup()
    first.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 500' }),
    ])
    second.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 502' }),
    ])
    const one = await run('the task')
    expect(one.outcome.kind).toBe('error')
    let seen = ''
    first.appendResponses([
      (context) => {
        seen = texts(context)
        return fauxAssistantMessage('done now')
      },
    ])
    const stored = findRun(db, one.runId)
    const again = await runAgent({
      rules,
      task: null,
      cwd,
      db,
      models: one.models,
      contextFiles: [],
      resume: stored,
    })
    expect(again.outcome).toMatchObject({ kind: 'done', text: 'done now' })
    expect(seen).toContain('the task')
    expect(seen).not.toContain('HTTP 50')
    // A finished run needs a prompt to go on.
    const done = await runAgent({
      rules,
      task: null,
      cwd,
      db,
      models: one.models,
      contextFiles: [],
      resume: findRun(db, one.runId),
    })
    expect(done.outcome).toMatchObject({
      kind: 'error',
      detail: expect.stringMatching(/give a prompt/),
    })
  })

  it('branches at a turn: the new run has the conversation up to that turn and nothing after', async () => {
    const { first, db, run, rules, cwd } = setup()
    first.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo turn-one' })),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo turn-two' })),
      fauxAssistantMessage('finished'),
    ])
    const one = await run('the task')
    let seen = ''
    first.appendResponses([
      (context) => {
        seen = texts(context)
        return fauxAssistantMessage('branch answer')
      },
    ])
    const branch = await runAgent({
      rules,
      task: 'try another way',
      cwd,
      db,
      models: one.models,
      contextFiles: [],
      branch: { from: findRun(db, one.runId), turn: 1 },
    })
    expect(branch.runId).not.toBe(one.runId)
    expect(branch.outcome).toMatchObject({ kind: 'done', text: 'branch answer' })
    expect(seen).toContain('turn-one')
    expect(seen).not.toContain('turn-two')
    expect(seen).toContain('try another way')
    expect(
      db.prepare('SELECT parent_id, branch_turn FROM runs WHERE id = ?').get(branch.runId),
    ).toEqual({
      parent_id: one.runId,
      branch_turn: 1,
    })
    // The source run is untouched.
    expect(
      db.prepare('SELECT count(*) AS n FROM messages WHERE run_id = ?').get(one.runId),
    ).toEqual({ n: 6 })
    await expect(
      runAgent({
        rules,
        task: 'x',
        cwd,
        db,
        models: one.models,
        contextFiles: [],
        branch: { from: findRun(db, one.runId), turn: 9 },
      }),
    ).rejects.toThrow(/turns 1 to 3/)
  })
})

describe('compaction', () => {
  const SUMMARY = 'SUMMARY-OF-EARLIER-WORK'
  /** Pi's two summarization requests: the history summary and a split turn's prefix. */
  const summarizing = (context: TranscriptContext) =>
    /context summarization assistant|Create a concise checkpoint/.test(texts(context))

  it('compacts a long run with Pi, the way Pi triggers it, and the run goes on', async () => {
    const { cwd, db, run, rules } = setup()
    writeFileSync(join(cwd, 'big.txt'), `${'lorem ipsum dolor sit amet '.repeat(300)}\n`)
    const script = [
      fauxAssistantMessage(fauxToolCall('read', { path: 'big.txt' })),
      fauxAssistantMessage(fauxToolCall('read', { path: 'big.txt' })),
      fauxAssistantMessage(fauxToolCall('read', { path: 'big.txt' })),
      fauxAssistantMessage('all read'),
    ]
    let afterCompaction = ''
    let compacted = false
    const step = (context: TranscriptContext) => {
      if (summarizing(context)) {
        compacted = true
        return fauxAssistantMessage(SUMMARY)
      }
      if (compacted && !afterCompaction) afterCompaction = texts(context)
      return script.shift() ?? fauxAssistantMessage('extra')
    }
    const settings = { enabled: true, reserveTokens: 1500, keepRecentTokens: 1200 }
    const lines: string[] = []
    const result = await run('read big.txt three times', {
      compaction: settings,
      log: (line) => lines.push(line),
      models: (() => {
        // A small window, so three reads go over the threshold.
        const models = createModels()
        const small = fauxProvider({
          provider: 'openai',
          api: 'faux-openai-small',
          models: [{ id: 'gpt-6.1-sol', reasoning: true, contextWindow: 4000 }],
        })
        small.setResponses(Array.from({ length: 12 }, () => step))
        models.setProvider(small.provider)
        return models
      })(),
    })
    expect(result.outcome).toMatchObject({ kind: 'done', text: 'all read' })
    expect(result.compactions).toBeGreaterThanOrEqual(1)
    expect(lines.join('\n')).toMatch(/compacted \(threshold\)/)
    expect(afterCompaction).toContain(SUMMARY)
    const row = db
      .prepare("SELECT content, meta FROM messages WHERE run_id = ? AND role = 'compaction'")
      .get(result.runId)
    expect(String(row?.content)).toContain(SUMMARY)
    expect(JSON.parse(String(row?.meta)).firstKeptSeq).toBeGreaterThan(0)

    // A resumed run starts from the summary, not the whole history.
    let resumed = ''
    const again = createModels()
    const next = fauxProvider({
      provider: 'openai',
      api: 'faux-openai-again',
      models: [{ id: 'gpt-6.1-sol', reasoning: true, contextWindow: 400_000 }],
    })
    next.setResponses([
      (context) => {
        resumed = texts(context)
        return fauxAssistantMessage('resumed')
      },
    ])
    again.setProvider(next.provider)
    const two = await runAgent({
      rules,
      task: 'and now?',
      cwd,
      db,
      models: again,
      contextFiles: [],
      resume: findRun(db, result.runId),
    })
    expect(two.outcome).toMatchObject({ kind: 'done', text: 'resumed' })
    expect(resumed).toContain(SUMMARY)
    expect(resumed).not.toContain('read big.txt three times')
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
