import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@aico/store'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { ChatSessions } from './chats'
import { contextMessages } from './compaction'
import type { RoleRules } from './rules'
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
