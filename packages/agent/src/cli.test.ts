// `aico agent run` exit codes: 2 usage, 3 refused by the rules, 4 the model refused or was
// swapped, 1 an error (with the runs row finished and one clean line), plus the notice when
// the test refusal hook comes from the environment.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './cli'
import type { RoleRules } from './rules'
import { openAgentDb, type RunReport } from './transcript'

const rules: RoleRules = {
  role: 'implementation',
  chain: [
    { id: 'codex/gpt-6.1-sol', piProvider: 'openai', piModel: 'gpt-6.1-sol', effort: 'high' },
  ],
  level: 'lean',
  tools: ['read'],
  guardHook: null,
  egress: 'host',
  hosts: null,
  contain: null,
}

function faux() {
  const provider = fauxProvider({
    provider: 'openai',
    api: 'faux-openai',
    models: [{ id: 'gpt-6.1-sol', reasoning: true }],
  })
  const models = createModels()
  models.setProvider(provider.provider)
  return { provider, models }
}

function io() {
  const err: string[] = []
  const out: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => err.push(String(chunk)) > 0)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => out.push(String(chunk)) > 0)
  return { err: () => err.join(''), out: () => out.join('') }
}

const dataDir = () => mkdtempSync(join(tmpdir(), 'aico-agent-cli-'))
const deps = (models: ReturnType<typeof faux>['models']) => ({
  rules: () => rules,
  models,
  cwd: dataDir(),
  // Never the live Tether.
  push: async () => {},
})

afterEach(() => vi.restoreAllMocks())

describe('aico agent run', () => {
  it('exits 2 on a usage error', async () => {
    const out = io()
    expect(await main(['run', 'task'], {})).toBe(2)
    expect(await main(['nope'], {})).toBe(2)
    expect(out.err()).toContain('--role and a task are required')
  })

  it('exits 3 when the role rules cannot be read', async () => {
    const out = io()
    const env = { AICO_DATA_DIR: dataDir() }
    expect(await main(['run', '--role', 'implementation', '--json', 'task'], env)).toBe(3)
    expect(JSON.parse(out.out())).toMatchObject({ outcome: { reason: 'rules_unreadable' } })
  })

  it('exits 4 when the last model refuses, and 4 on a model swap', async () => {
    io()
    const env = { AICO_DATA_DIR: dataDir() }
    const refusing = faux()
    refusing.provider.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'cyber_policy: no' }),
    ])
    expect(
      await main(['run', '--role', 'implementation', 'task'], env, deps(refusing.models)),
    ).toBe(4)
    const swapped = faux()
    swapped.provider.setResponses([{ ...fauxAssistantMessage('hi'), responseModel: 'gpt-5-mini' }])
    expect(await main(['run', '--role', 'implementation', 'task'], env, deps(swapped.models))).toBe(
      4,
    )
  })

  it('exits 0 with the answer, and says so when the refusal hook comes from the environment', async () => {
    const out = io()
    const answering = faux()
    answering.provider.setResponses([fauxAssistantMessage('all done')])
    const env = { AICO_DATA_DIR: dataDir(), AICO_AGENT_TEST_REFUSE_AT: '5' }
    expect(
      await main(['run', '--role', 'implementation', 'task'], env, deps(answering.models)),
    ).toBe(0)
    expect(out.out()).toBe('all done\n')
    expect(out.err()).toContain('AICO_AGENT_TEST_REFUSE_AT=5 is set')
  })

  it('exits 1 with one clean line and a finished runs row when the run throws', async () => {
    const out = io()
    const dir = dataDir()
    const broken = {
      getModel: () => {
        throw new Error('provider list broke')
      },
    } as unknown as ReturnType<typeof faux>['models']
    const env = { AICO_DATA_DIR: dir }
    expect(
      await main(['run', '--role', 'implementation', '--json', 'task'], env, deps(broken)),
    ).toBe(1)
    expect(JSON.parse(out.out())).toMatchObject({
      outcome: { kind: 'error', detail: 'provider list broke' },
    })
    const db = openAgentDb(join(dir, 'agent.db'))
    expect(db.prepare('SELECT outcome FROM runs').all()).toEqual([{ outcome: 'error' }])
    db.close()
  })

  it('exits 1 with one clean line when agent.db cannot be opened', async () => {
    const out = io()
    const dir = dataDir()
    writeFileSync(join(dir, 'agent.db'), 'not a database '.repeat(100))
    const env = { AICO_DATA_DIR: dir }
    expect(
      await main(['run', '--role', 'implementation', '--json', 'task'], env, deps(faux().models)),
    ).toBe(1)
    expect(JSON.parse(out.out())).toMatchObject({ outcome: { kind: 'error' } })
    expect(out.err()).toMatch(/^aico agent: error: .*\n$/)
  })
})

describe('aico agent run --resume / --branch, and show', () => {
  it('refuses bad combinations before opening agent.db', async () => {
    const out = io()
    expect(await main(['run', '--resume', 'a', '--branch', 'a@1'], {})).toBe(2)
    expect(await main(['run', '--branch', 'a', 'task'], {})).toBe(2)
    expect(await main(['run', '--role', 'implementation', '--run-id', 'x', 'task'], {})).toBe(2)
    expect(out.err()).toContain('--resume and --branch do not go together')
    expect(out.err()).toContain('--branch takes RUN@TURN')
    expect(out.err()).toContain('--run-id takes a UUID')
  })

  it('resumes by id prefix, branches at a turn, and show lists each turn with its model', async () => {
    const out = io()
    const env = { AICO_DATA_DIR: dataDir() }
    const { provider, models } = faux()
    provider.setResponses([
      fauxAssistantMessage('one'),
      fauxAssistantMessage('two'),
      fauxAssistantMessage('branched'),
    ])
    const id = '0f6a2b4c-1d2e-4f30-8a9b-0c1d2e3f4a5b'
    expect(
      await main(['run', '--role', 'implementation', '--run-id', id, 'first'], env, deps(models)),
    ).toBe(0)
    expect(await main(['run', '--resume', id.slice(0, 8), 'second'], env, deps(models))).toBe(0)
    expect(
      await main(['run', '--role', 'research', '--resume', id, 'third'], env, deps(models)),
    ).toBe(2)
    expect(out.err()).toContain("is a 'implementation' run")
    expect(await main(['run', '--branch', `${id}@1`, 'other'], env, deps(models))).toBe(0)
    expect(out.out()).toBe('one\ntwo\nbranched\n')

    const shown = io()
    expect(await main(['show', id.slice(0, 8)], env)).toBe(0)
    expect(shown.out()).toMatch(/turn 1 {2}codex\/gpt-6\.1-sol {2}stop/)
    expect(shown.out()).toMatch(/turn 2 {2}codex\/gpt-6\.1-sol {2}stop/)
    const db = openAgentDb(join(env.AICO_DATA_DIR, 'agent.db'))
    const branch = db.prepare('SELECT id FROM runs WHERE parent_id = ?').get(id) as { id: string }
    db.close()
    const json = io()
    expect(await main(['show', branch.id, '--json'], env)).toBe(0)
    expect(JSON.parse(json.out())).toMatchObject({
      run: { parent_id: id, branch_turn: 1, outcome: 'done' },
      turns: [{ turn: 1 }, { turn: 2 }],
    })
    expect(await main(['show', 'nope'], env)).toBe(1)
  })

  it('refuses --resume with nothing to continue, leaving the finished run as it was', async () => {
    const env = { AICO_DATA_DIR: dataDir() }
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('one')])
    const id = '1f6a2b4c-1d2e-4f30-8a9b-0c1d2e3f4a5b'
    const out = io()
    expect(
      await main(['run', '--role', 'implementation', '--run-id', id, 'first'], env, deps(models)),
    ).toBe(0)
    const read = () => {
      const db = openAgentDb(join(env.AICO_DATA_DIR, 'agent.db'))
      try {
        return db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
      } finally {
        db.close()
      }
    }
    const before = read()
    expect(before).toMatchObject({ outcome: 'done' })
    expect(await main(['run', '--resume', id], env, deps(models))).toBe(1)
    expect(out.err()).toContain('give a prompt to go on')
    expect(read()).toEqual(before)
  })
})

describe('aico agent run --interactive', () => {
  it('waits for the first prompt, then goes on in the same run after each answer', async () => {
    const out = io()
    const env = { AICO_DATA_DIR: dataDir() }
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')])
    const prompts = ['first', 'second', null]
    const prompt = async () => prompts.shift() ?? null
    expect(
      await main(['run', '--interactive', '--role', 'implementation', '--', ''], env, {
        ...deps(models),
        prompt,
      }),
    ).toBe(0)
    expect(out.out()).toBe('one\ntwo\n')
    const db = openAgentDb(join(env.AICO_DATA_DIR, 'agent.db'))
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 })
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE role = 'user'").get()).toEqual({
      n: 2,
    })
    db.close()
    expect(await main(['run', '--interactive', '--json', '--role', 'x'], env)).toBe(2)
  })

  it('starts a run Tether resumes before its first prompt fresh under that id', async () => {
    io()
    const env = { AICO_DATA_DIR: dataDir() }
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('one')])
    const prompts = ['first', null]
    const id = '1a6a2b4c-1d2e-4f30-8a9b-0c1d2e3f4a5b'
    expect(
      await main(['run', '--interactive', '--role', 'implementation', '--resume', id], env, {
        ...deps(models),
        prompt: async () => prompts.shift() ?? null,
      }),
    ).toBe(0)
    const db = openAgentDb(join(env.AICO_DATA_DIR, 'agent.db'))
    expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id }])
    db.close()
  })
})

describe('telling Tether', () => {
  it('pushes the run at its start and end: totals, tool calls and the model of each turn', async () => {
    io()
    const env = { AICO_DATA_DIR: dataDir() }
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')])
    const pushed: RunReport[] = []
    const prompts = ['second', null]
    expect(
      await main(['run', '--interactive', '--role', 'implementation', 'first'], env, {
        ...deps(models),
        prompt: async () => prompts.shift() ?? null,
        push: async (report) => {
          pushed.push(report)
        },
      }),
    ).toBe(0)
    expect(pushed.map((report) => [report.endedAt === null, report.outcome])).toEqual([
      [true, null],
      [false, 'completed'],
      [true, null],
      [false, 'completed'],
    ])
    const last = pushed.at(-1) as RunReport
    expect(new Set(pushed.map((report) => report.id)).size).toBe(1)
    expect(last).toMatchObject({
      role: 'implementation',
      toolCalls: 0,
      turns: [
        { turn: 1, model: 'codex/gpt-6.1-sol', stop: 'stop' },
        { turn: 2, model: 'codex/gpt-6.1-sol', stop: 'stop' },
      ],
    })
    expect(last.tokens.input + last.tokens.output).toBeGreaterThan(0)
  })

  it('runs and logs it when Tether is not there', async () => {
    const out = io()
    const dir = dataDir()
    const env = { AICO_DATA_DIR: dir, TETHER_SOCKET: join(dir, 'no-tether.sock') }
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('done')])
    const { push: _live, ...withoutPush } = deps(models)
    expect(await main(['run', '--role', 'implementation', 'task'], env, withoutPush)).toBe(0)
    expect(out.out()).toBe('done\n')
    expect(out.err()).toContain('not in the session history:')
  })
})
