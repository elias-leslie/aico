import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, type Facts, type LaunchPolicy } from '@aico/context'
import { openDatabase } from '@aico/store'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { ChatSessions } from './chats'
import { contextMessages } from './compaction'
import policyData from './fixtures/policy.json' with { type: 'json' }
import { HARNESS, loadRoutedRules, type RoleRules, roleRules } from './rules'
import { MIGRATIONS, openAgentDb, Transcript } from './transcript'

const rules: RoleRules = {
  role: 'implementation',
  chain: [{ id: 'first', piProvider: 'openai', piModel: 'first', effort: null }],
  level: 'read',
  tools: ['read'],
  guardHook: null,
  egress: 'host',
  hosts: null,
  contain: null,
}
it('migrates an M8b-1 database without replaying its owner-column migration', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aico-chat-migration-'))
  const path = join(folder, 'agent.db')
  const old = openDatabase(path, MIGRATIONS.slice(0, 4))
  old.close()
  const db = openAgentDb(path)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chats'").get()).toMatchObject({
    name: 'chats',
  })
  db.close()
  rmSync(folder, { recursive: true, force: true })
})
describe('chat restart recovery', () => {
  it('retains streamed text as unfinished, keeps drafts and excludes that partial response from resumed context', () => {
    const db = openAgentDb(':memory:')
    const transcript = new Transcript(db, '1234abcd', {
      role: 'implementation',
      cwd: '/scratch',
      task: 'question',
      chain: rules.chain,
    })
    transcript.message({
      role: 'user',
      content: [{ type: 'text', text: 'question' }],
      message: { role: 'user', content: 'question', timestamp: 1 },
    })
    db.prepare(
      "INSERT INTO chats (run_id, title, state, updated_at, draft, partial) VALUES (?, ?, 'working', 1, ?, ?)",
    ).run(
      '1234abcd',
      'Question',
      'unsent draft',
      JSON.stringify({ text: 'Partial reply received', model: 'first', turn: 1 }),
    )
    const chats = new ChatSessions(db, {
      dataDir: '/scratch',
      push: async () => {},
      rules: () => rules,
    })
    expect(chats.get('1234abcd')).toMatchObject({
      state: 'stopped',
      partial: null,
      draft: 'unsent draft',
    })
    expect(chats.get('1234abcd').messages.at(-1)).toMatchObject({
      stop_reason: 'aborted',
      content: [{ type: 'text', text: 'Partial reply received' }],
    })
    expect(contextMessages(Transcript.open(db, '1234abcd').entries)).toHaveLength(1)
    db.close()
  })
})

describe('queued messages after a reply that did not finish', () => {
  it('moves them back to the draft when the reply fails', async () => {
    const faux = fauxProvider({
      provider: 'openai',
      api: 'faux-openai',
      models: [{ id: 'first', reasoning: true }],
    })
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'boom' })])
    const models = createModels()
    models.setProvider(faux.provider)
    const db = openAgentDb(':memory:')
    const cwd = mkdtempSync(join(tmpdir(), 'aico-chat-queue-'))
    const chats = new ChatSessions(db, {
      dataDir: cwd,
      push: async () => {},
      rules: () => rules,
      models,
      contextFiles: [],
    })
    const { id } = await chats.start({ role: 'implementation', cwd, message: 'first question' })
    chats.send(id, 'queued follow-up')
    expect(chats.get(id).queued).toEqual(['queued follow-up'])
    await chats.settled(id)
    expect(chats.get(id)).toMatchObject({ state: 'failed', queued: [], draft: 'queued follow-up' })
    db.close()
    rmSync(cwd, { recursive: true, force: true })
  })
})

describe('chat model choice and used-up subscriptions', () => {
  const policy = policyData as unknown as LaunchPolicy
  const reading = (provider: string, usedPercent: number) => ({
    provider,
    window_minutes: 10080,
    observed_at: '2026-11-06T19:55:00.000Z',
    used_percent: usedPercent,
    resets_at: '2026-11-11T10:00:00.000Z',
    source: 'test',
  })
  const chatChain = (used: Record<string, number>) => {
    const facts: Facts = {
      readings: Object.entries(used).map(([provider, percent]) => reading(provider, percent)),
      credits: {},
      refusals: [],
    }
    const chats = new ChatSessions(openAgentDb(':memory:'), {
      dataDir: '/scratch',
      push: async () => {},
      rules: (_db, request) => roleRules(policy, new Catalog(), HARNESS, request),
      facts: () => ({ facts, collectedAt: '2026-11-06T19:55:00.000Z' }),
    })
    return chats
      .choices('/scratch')
      .find((choice) => choice.role === 'implementation')
      ?.chain.map((entry) => entry.id)
  }
  it('the web chat skips a used-up provider and falls back to the next, as aico agent does', () => {
    expect(chatChain({})).toEqual([
      'codex/gpt-6.1-sol',
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/glm-5.3',
    ])
    expect(chatChain({ codex: 100 })).toEqual([
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/glm-5.3',
    ])
    expect(chatChain({ codex: 100, 'opencode-go': 100 })).toEqual([])
  })
  it('chat and CLI route through the same function', () => {
    const facts: Facts = { readings: [reading('codex', 100)], credits: {}, refusals: [] }
    const direct = loadRoutedRules(
      '/scratch',
      { role: 'implementation', cwd: '/scratch' },
      {
        load: (_db, request) => roleRules(policy, new Catalog(), HARNESS, request),
        facts: () => ({ facts, collectedAt: '' }),
        now: '2026-11-06T20:00:00.000Z',
      },
    ) as RoleRules
    expect(direct.skipped?.map((entry) => entry.id)).toEqual(['codex/gpt-6.1-sol'])
  })
})

describe('listing chats stays cheap', () => {
  const seed = (
    db: ReturnType<typeof openAgentDb>,
    id: string,
    state: string,
    startedBy: string,
  ) => {
    new Transcript(db, id, {
      role: 'implementation',
      cwd: '/scratch',
      task: id,
      chain: rules.chain,
    })
    db.prepare(
      'INSERT INTO chats (run_id, title, state, updated_at, started_by) VALUES (?, ?, ?, 1, ?)',
    ).run(id, id, state, startedBy)
  }
  const build = () => {
    const db = openAgentDb(':memory:')
    seed(db, 'aaaa0001', 'ended', 'a-term:12345678')
    seed(db, 'aaaa0002', 'idle', 'a-term:87654321')
    let reads = 0
    const chats = new ChatSessions(db, {
      dataDir: '/scratch/none',
      push: async () => {},
      rules: () => rules,
      facts: () => {
        reads++
        return { error: 'not collected' }
      },
    })
    return { chats, reads: () => reads }
  }
  it('listOpen leaves ended chats out without summarising them', () => {
    const { chats, reads } = build()
    expect(chats.listOpen().map((chat) => chat.id)).toEqual(['aaaa0002'])
    expect(reads()).toBe(1)
  })
  it('startedBy reads one column and never touches the routing facts', () => {
    const { chats, reads } = build()
    expect(chats.startedBy('aaaa0001')).toBe('a-term:12345678')
    expect(chats.startedBy('nope0000')).toBeNull()
    expect(reads()).toBe(0)
  })
  it('summaries share one rules read until usage or context files change', () => {
    const { chats, reads } = build()
    chats.summary('aaaa0001')
    chats.summary('aaaa0002')
    chats.summary('aaaa0002')
    expect(reads()).toBe(1)
  })
})
