import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMemory, listMemories, type Memory, openContext } from '@aico/context'
import { withFileLock } from '@aico/shared/durable-file'
import { afterEach, expect, it } from 'vitest'
import {
  syncCanaryCursor,
  syncPhones,
  takeStandbyAppRows,
  takeStandbyMemories,
} from './context-sync'

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
  const exec = async (_s: string, argv: string[], input: Buffer): Promise<Answer> => {
    calls.push(argv.at(-1) as string)
    const path = join(dir, 'phones.json')
    // Exchanges serialize through their own lock, while the phone API can still write.
    expect(spawnSync('flock', ['-n', '-E', '75', `${path}.sync.lock`, 'true']).status).toBe(75)
    expect(spawnSync('flock', ['-n', '-E', '75', `${path}.lock`, 'true']).status).toBe(0)
    if (calls.length === 2) {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(12)
      expect(JSON.parse(input.toString())).toEqual({ receipt: 'large-list-reply' })
    }
    return calls.length === 1
      ? {
          code: 0,
          stdout: `${JSON.stringify({ phones: many, receipt: 'large-list-reply' })}\n`,
          output: '',
          ended: true,
        }
      : { code: 0, stdout: '', output: '', ended: true }
  }
  const result = await syncPhones(peers, aico, env, exec as never)
  expect(result).toEqual({ lines: ['standby: 12 phones in step'], failed: false })
  expect(calls[0]).toContain('phones merge')
  expect(calls[1]).toContain('phones merge-done')
  expect(JSON.parse(readFileSync(join(dir, 'phones.json'), 'utf8'))).toHaveLength(12)
})

it("mends an unreadable phone list from the peer's copy, and sends it nothing", async () => {
  const { dir, env } = setup()
  const path = join(dir, 'phones.json')
  writeFileSync(path, '')
  const calls: string[] = []
  const answer = (stdout: string, code = 0): Answer => ({ code, stdout, output: '', ended: true })
  const exec = async (_: string, argv: string[]) => {
    calls.push(argv.join(' '))
    return answer(`${JSON.stringify([{ id: 'a' }, { id: 'b' }])}\n`)
  }
  const result = await syncPhones(peers, aico, env, exec as never)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('phones dump')
  expect(result.failed).toBe(false)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(2)

  writeFileSync(path, '[{"id":')
  const nothing = await syncPhones(peers, aico, env, (async () => answer('', 1)) as never)
  expect(nothing.failed).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('[{"id":')
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

it.each([
  [{ id: 'legacy-copy' }],
  { phones: [{ id: 'unreceipted-copy' }] },
  { phones: [{ id: 'empty-receipt' }], receipt: '' },
  { phones: [{ id: 'invalid-receipt' }], receipt: 123 },
])('does not store or confirm a peer reply without an exchange receipt: %j', async (reply) => {
  const { dir, env } = setup()
  const path = join(dir, 'phones.json')
  const snapshot = JSON.stringify([{ id: 'local' }])
  writeFileSync(path, snapshot)
  let calls = 0
  const exec = async (): Promise<Answer> => {
    calls++
    return { code: 0, stdout: JSON.stringify(reply), output: '', ended: true }
  }
  expect((await syncPhones(peers, aico, env, exec as never)).failed).toBe(true)
  expect(calls).toBe(1)
  expect(readFileSync(path, 'utf8')).toBe(snapshot)
})

it('keeps local phone changes during a delayed reply, and leaves the peer unconfirmed until the next sync', async () => {
  const { dir, env } = setup()
  const path = join(dir, 'phones.json')
  writeFileSync(path, JSON.stringify([{ id: 'removed' }, { id: 'kept', last_ack: 1 }]))
  const calls: string[] = []
  const exec = async (_s: string, argv: string[], input: Buffer): Promise<Answer> => {
    calls.push(argv.at(-1) as string)
    if (calls.length === 1) {
      expect(JSON.parse(input.toString())).toEqual([{ id: 'removed' }, { id: 'kept', last_ack: 1 }])
      // Phone API writers take this same lock; they remain free while the fleet link answers.
      await withFileLock(path, () => {
        writeFileSync(path, JSON.stringify([{ id: 'kept', last_ack: 3 }, { id: 'paired-here' }]))
      })
      return {
        code: 0,
        stdout: JSON.stringify({
          phones: [{ id: 'removed' }, { id: 'kept', last_ack: 2 }, { id: 'paired-there' }],
          receipt: 'declined-reply',
        }),
        output: '',
        ended: true,
      }
    }
    if (argv.at(-1)?.endsWith('phones merge')) {
      expect(JSON.parse(input.toString())).toEqual([
        { id: 'kept', last_ack: 3 },
        { id: 'paired-here' },
      ])
      return {
        code: 0,
        stdout: JSON.stringify({
          phones: [{ id: 'kept', last_ack: 3 }, { id: 'paired-here' }, { id: 'paired-there' }],
          receipt: 'stored-reply',
        }),
        output: '',
        ended: true,
      }
    }
    return { code: 0, stdout: '', output: '', ended: true }
  }
  const changed = await syncPhones(peers, aico, env, exec as never)
  expect(changed.failed).toBe(false)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
    { id: 'kept', last_ack: 3 },
    { id: 'paired-here' },
  ])
  expect(calls).toHaveLength(1)
  await syncPhones(peers, aico, env, exec as never)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
    { id: 'kept', last_ack: 3 },
    { id: 'paired-here' },
    { id: 'paired-there' },
  ])
  expect(calls[2]).toContain('phones merge-done')
})

it('does not overwrite a phone list repaired locally while it waits for a peer copy', async () => {
  const { dir, env } = setup()
  const path = join(dir, 'phones.json')
  writeFileSync(path, '')
  const exec = async (): Promise<Answer> => {
    await withFileLock(path, () => writeFileSync(path, JSON.stringify([{ id: 'local-repair' }])))
    return { code: 0, stdout: '[{"id":"old-copy"}]', output: '', ended: true }
  }
  expect((await syncPhones(peers, aico, env, exec as never)).failed).toBe(false)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'local-repair' }])
})

it('releases both locks when the fleet request throws, so the next sync can finish', async () => {
  const { dir, env } = setup()
  writeFileSync(join(dir, 'phones.json'), '[{"id":"a"}]')
  await expect(
    syncPhones(peers, aico, env, (async () => {
      throw new Error('link broke')
    }) as never),
  ).rejects.toThrow('link broke')
  const answer = async (): Promise<Answer> => ({
    code: 0,
    stdout: '{"phones":[{"id":"a"}],"receipt":"retry-reply"}',
    output: '',
    ended: true,
  })
  expect((await syncPhones(peers, aico, env, answer as never)).failed).toBe(false)
})

it('never resurrects a newly sent phone removed while its unconfirmed reply is in flight', async () => {
  const { dir, env } = setup()
  const source = join(dir, 'phones.json')
  const receiver = join(dir, 'receiver.json')
  const phone = (id: string, added_at: number) => ({
    id,
    added_at,
    sig_pub: 'sig',
    enc_pub: 'enc',
    auth: 'auth',
  })
  const kept = phone('kept', 1)
  writeFileSync(source, JSON.stringify([kept, phone('new-at-source', 150)]))
  writeFileSync(receiver, JSON.stringify([kept, phone('new-at-receiver', 150)]))
  writeFileSync(`${receiver}.sync.json`, JSON.stringify({ at: 100, ids: ['kept'] }))
  // Execute the real answering side in its own process, just as a fleet command does.
  const moduleUrl = new URL('../../web-server/src/app-phones.ts', import.meta.url).href
  const script = `import {mergePhonesFile, confirmPhonesMerge} from ${JSON.stringify(moduleUrl)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const {path, verb, phones, now, receipt} = JSON.parse(input);
    const result = verb === 'merge' ? await mergePhonesFile(path, phones, now) : await confirmPhonesMerge(path, receipt);
    console.log(JSON.stringify(result ?? null));`
  let calls = 0
  const exec = async (_s: string, argv: string[], input: Buffer): Promise<Answer> => {
    const verb = argv.at(-1)?.endsWith('phones merge-done') ? 'confirm' : 'merge'
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--input-type=module', '-e', script],
      {
        input: JSON.stringify({
          path: receiver,
          verb,
          phones: verb === 'merge' ? JSON.parse(input.toString()) : [],
          receipt: verb === 'confirm' ? JSON.parse(input.toString()).receipt : undefined,
          now: 200 + calls,
        }),
        encoding: 'utf8',
      },
    )
    expect(result.status, result.stderr).toBe(0)
    if (++calls === 1)
      await withFileLock(source, () => writeFileSync(source, JSON.stringify([kept])))
    return { code: result.status ?? 1, stdout: result.stdout, output: result.stderr, ended: true }
  }
  await syncPhones(peers, aico, env, exec as never)
  expect(calls).toBe(1) // The changed source refused that first reply and sent no confirmation.
  await syncPhones(peers, aico, env, exec as never)
  const ids = (path: string) =>
    (JSON.parse(readFileSync(path, 'utf8')) as { id: string }[]).map((p) => p.id)
  expect(ids(source)).toEqual(['kept', 'new-at-receiver'])
  expect(ids(receiver)).toEqual(['kept', 'new-at-receiver'])
})

it('does not let a delayed old confirmation acknowledge a newer reply the source declined', async () => {
  const { dir, env } = setup()
  const source = join(dir, 'phones.json')
  const receiver = join(dir, 'receiver.json')
  const kept = {
    id: 'kept',
    pairing_id: 'kept-pair',
    added_at: 1,
    sig_pub: 'sig',
    enc_pub: 'enc',
    auth: 'auth',
  }
  const pairedThere = { ...kept, id: 'paired-there', pairing_id: 'local-pair', added_at: 200 }
  writeFileSync(source, JSON.stringify([kept]))
  writeFileSync(receiver, JSON.stringify([kept]))
  const moduleUrl = new URL('../../web-server/src/app-phones.ts', import.meta.url).href
  const script = `import {mergePhonesFile, confirmPhonesMerge} from ${JSON.stringify(moduleUrl)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const {path, verb, payload} = JSON.parse(input);
    const data = payload ? JSON.parse(payload) : null;
    const result = verb === 'merge' ? await mergePhonesFile(path, data, 200)
      : await confirmPhonesMerge(path, data?.receipt);
    console.log(JSON.stringify(result ?? null));`
  const answer = (verb: string, payload: Buffer): Answer => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--input-type=module', '-e', script],
      {
        input: JSON.stringify({ path: receiver, verb, payload: payload.toString() }),
        encoding: 'utf8',
      },
    )
    expect(result.status, result.stderr).toBe(0)
    return { code: result.status ?? 1, stdout: result.stdout, output: result.stderr, ended: true }
  }
  let delayedConfirm: Buffer | undefined
  let merges = 0
  const exec = async (_s: string, argv: string[], input: Buffer): Promise<Answer> => {
    if (argv.at(-1)?.endsWith('phones merge-done')) {
      if (!delayedConfirm) {
        delayedConfirm = Buffer.from(input)
        return gone // The remote command survives the source losing its connection.
      }
      return answer('merge-done', input)
    }
    const result = answer('merge', input)
    if (++merges === 2) {
      // The new reply now contains the receiver-local pairing. The prior command finally runs.
      answer('merge-done', delayedConfirm as Buffer)
      // The source changes while this reply is in flight, so it refuses to store or confirm it.
      await withFileLock(source, () =>
        writeFileSync(source, JSON.stringify([{ ...kept, last_ack: 300 }])),
      )
    }
    return result
  }
  await syncPhones(peers, aico, env, exec as never)
  writeFileSync(receiver, JSON.stringify([kept, pairedThere]))
  expect((await syncPhones(peers, aico, env, exec as never)).lines).toEqual([
    'standby: the phone list changed here; the next run catches it up',
  ])
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual([{ ...kept, last_ack: 300 }])
  await syncPhones(peers, aico, env, exec as never)
  const ids = (path: string) =>
    (JSON.parse(readFileSync(path, 'utf8')) as { id: string }[]).map((phone) => phone.id)
  expect(ids(source)).toEqual(['kept', 'paired-there'])
  expect(ids(receiver)).toEqual(['kept', 'paired-there'])
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

it('takes back only the app reports the standby heard newer, as plain rows', async () => {
  const row = (id: string, project: string, last_run: string) => ({
    id,
    what: id,
    kind: 'job',
    machine: 'apps',
    state: 'ok',
    meaning: 'Last run completed.',
    project,
    last_run,
    next_run: '2026-11-08T22:00:00.000Z',
    shown: 'ok',
    updated_at: last_run,
  })
  const standby = [
    row('portfolio-ai/fg-inputs', 'portfolio-ai', '2026-11-08T17:15:21.000Z'),
    row('portfolio-ai/same', 'portfolio-ai', '2026-11-08T10:00:00.000Z'),
    row('portfolio-ai/older', 'portfolio-ai', '2026-11-08T09:00:00.000Z'),
    row('jobinator-4000/new-here', 'jobinator-4000', '2026-11-08T12:00:00.000Z'),
    row('aico/backup/x', 'aico', '2026-11-08T18:00:00.000Z'),
  ]
  const here = [
    { id: 'portfolio-ai/fg-inputs', last_run: '2026-11-08T15:49:34.000Z' },
    { id: 'portfolio-ai/same', last_run: '2026-11-08T10:00:00.000Z' },
    { id: 'portfolio-ai/older', last_run: '2026-11-08T11:00:00.000Z' },
    { id: 'aico/backup/x', last_run: '2026-11-08T01:00:00.000Z' },
  ]
  const exec = async () => ({
    code: 0,
    stdout: JSON.stringify({ rows: standby }),
    output: '',
    ended: true,
  })
  let posted: Record<string, unknown>[] = []
  const http = (async (url: URL, init?: RequestInit) => {
    if (!init?.body) return new Response(JSON.stringify({ rows: here }))
    expect(String(url)).toContain('/api/status/rows')
    posted = JSON.parse(String(init.body))
    return new Response('{}')
  }) as typeof fetch
  const lines = await takeStandbyAppRows(peers, aico, {}, exec as never, http)
  expect(posted.map((r) => r.id)).toEqual(['portfolio-ai/fg-inputs', 'jobinator-4000/new-here'])
  // A row that went out with reader fields would be refused (contracts/status-row.schema.json).
  expect(Object.keys(posted[0] as object)).not.toContain('shown')
  expect(Object.keys(posted[0] as object)).not.toContain('updated_at')
  expect(lines).toEqual(['standby: 2 app reports only it had heard'])
})

it('says and fails nothing when the standby is off or this Aico web is restarting', async () => {
  const down = (async () => {
    throw new Error('fetch failed')
  }) as typeof fetch
  expect(await takeStandbyAppRows(peers, aico, {}, (async () => gone) as never, down)).toEqual([])
  const answers = async () => ({ code: 0, stdout: '{"rows":[]}', output: '', ended: true })
  expect(await takeStandbyAppRows(peers, aico, {}, answers as never, down)).toEqual([])
})

it('names the projects that report through the standby, as the service apps do', () => {
  const apps = JSON.parse(
    readFileSync(new URL('../../web-server/data/service-apps.json', import.meta.url), 'utf8'),
  ).apps as Record<string, unknown>
  const projects = JSON.parse(
    readFileSync(new URL('../data/context-sync.json', import.meta.url), 'utf8'),
  ).appRowProjects as string[]
  expect([...projects].sort()).toEqual(Object.keys(apps).sort())
})
