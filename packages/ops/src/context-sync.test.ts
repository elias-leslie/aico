import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMemory, listMemories, type Memory, openContext } from '@aico/context'
import { afterEach, expect, it } from 'vitest'
import { syncCanaryCursor, syncPhones, takeStandbyMemories } from './context-sync'

type Answer = { code: number; stdout: string; output: string; ended: boolean }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const aico = (args: string) => ['sh', '-c', `aico ${args}`]
const peers = [{ name: 'standby', exec: 'unused.sock' }]
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-context-sync-test-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'canary'))
  return { dir, env: { AICO_DATA_DIR: dir, AICO_PHONE_DEVICES_FILE: join(dir, 'phones.json') } }
}
const gone: Answer = { code: 255, stdout: '', output: '', ended: false }

it('takes a phone list far longer than 4 KB and tells the peer only after it is stored', async () => {
  const { dir, env } = setup()
  writeFileSync(join(dir, 'phones.json'), JSON.stringify([{ id: 'a' }]))
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, pad: 'x'.repeat(950) }))
  const calls: string[] = []
  const exec = async (_s: string, argv: string[]): Promise<Answer> => {
    calls.push(argv.at(-1) as string)
    return calls.length === 1
      ? { code: 0, stdout: `${JSON.stringify(many)}\n`, output: '', ended: true }
      : { code: 0, stdout: '', output: '', ended: true }
  }
  const result = await syncPhones(peers, aico, env, exec as never)
  expect(result).toEqual({ lines: ['standby: 12 phones in step'], failed: false })
  expect(calls[0]).toContain('phones merge')
  expect(calls[1]).toContain('phones merge-done')
  expect(JSON.parse(readFileSync(join(dir, 'phones.json'), 'utf8'))).toHaveLength(12)
})

it('does not confirm a merge whose reply never came', async () => {
  const { dir, env } = setup()
  writeFileSync(join(dir, 'phones.json'), JSON.stringify([{ id: 'a' }]))
  const calls: string[] = []
  const exec = async (_s: string, argv: string[]): Promise<Answer> => {
    calls.push(argv.at(-1) as string)
    return gone
  }
  expect(await syncPhones(peers, aico, env, exec as never)).toEqual({ lines: [], failed: false })
  expect(calls).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(dir, 'phones.json'), 'utf8'))).toEqual([{ id: 'a' }])
})

it('sends the canary cursor and keeps the newer time per token from both sides', async () => {
  const { dir, env } = setup()
  const file = join(dir, 'canary', 'poll.json')
  writeFileSync(file, JSON.stringify({ a: 5, b: 9 }))
  let sent = ''
  const exec = async (_s: string, argv: string[], input: Buffer): Promise<Answer> => {
    expect(argv.at(-1)).toContain('phones canary-merge')
    sent = input.toString()
    // The peer had seen a newer hit for a and one more token.
    return { code: 0, stdout: `${JSON.stringify({ a: 7, b: 9, c: 1 })}\n`, output: '', ended: true }
  }
  const result = await syncCanaryCursor(peers, aico, env, exec as never)
  expect(JSON.parse(sent)).toEqual({ a: 5, b: 9 })
  expect(result).toEqual({ lines: ['standby: canary cursor in step'], failed: false })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 7, b: 9, c: 1 })
})

it('a canary cursor sync to a machine that is off is neither a failure nor a line', async () => {
  const { dir, env } = setup()
  writeFileSync(join(dir, 'canary', 'poll.json'), '{}')
  expect(await syncCanaryCursor(peers, aico, env, (async () => gone) as never)).toEqual({
    lines: [],
    failed: false,
  })
})

it('takes memories saved on the standby once, keeps this side on a clash, and a standby that is off is no failure', async () => {
  const { dir } = setup()
  const mainDb = join(dir, 'main.db')
  const db = openContext(mainDb)
  const mine = addMemory(db, { content: 'edited here', summary: 'mine' }, '2026-11-01T00:00:00Z')
  db.close()
  const theirs: Memory[] = [
    { ...mine, content: 'edited on the standby', version: 2 },
    {
      ...mine,
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      content: 'saved while away',
      createdAt: '2026-11-08T01:00:00Z',
      updatedAt: '2026-11-08T01:00:00Z',
    },
  ]
  const answer = (stdout: string): Answer => ({ code: 0, stdout, output: stdout, ended: true })
  const exec = async () => answer(`${JSON.stringify(theirs)}\n`)
  const peer = peers[0]
  const first = await takeStandbyMemories(peer, aico, mainDb, exec as never)
  expect(first).toEqual({
    added: 1,
    failed: false,
    line: 'standby: Took 1 memory saved on the standby',
  })
  const again = await takeStandbyMemories(peer, aico, mainDb, exec as never)
  expect(again).toEqual({ added: 0, failed: false, line: null })
  const after = openContext(mainDb)
  const all = listMemories(after, { scope: 'all' }).memories
  after.close()
  expect(all.map((m) => m.content).sort()).toEqual(['edited here', 'saved while away'])
  const off = await takeStandbyMemories(peer, aico, mainDb, (async () => gone) as never)
  expect(off).toEqual({ added: 0, failed: false, line: null })
})
