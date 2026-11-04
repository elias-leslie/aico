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
import { openAgentDb } from './transcript'

const rules: RoleRules = {
  role: 'implementation',
  chain: [
    { id: 'codex/gpt-6.1-sol', piProvider: 'openai', piModel: 'gpt-6.1-sol', effort: 'high' },
  ],
  level: 'lean',
  tools: ['read'],
  guardHook: null,
  egress: 'host',
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
