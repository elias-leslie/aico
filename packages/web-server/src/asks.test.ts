// Owner asks in the web server: Tether's asks checked again, one push per new
// blocking ask naming the session (never the question), the answer passed
// through, and the pending host grants as links.

import { describe, expect, it } from 'vitest'
import { type Ask, Asks, askNotice, validateAsk } from './asks'
import { NotesStore } from './notes-db'
import { QUIET, recorder } from './testing-notices'

const ASK: Ask = {
  id: 'abcdefabcdef',
  session: '0123abcd',
  requester: null,
  question: 'Finish the single Linux partition?',
  options: ['Finish it now', 'Stop here'],
  recommended: 0,
  body: 'Swap becomes a file.\nOne reboot.',
  command: null,
  share: null,
  attached: [],
  wantsFiles: null,
  files: [],
  blocking: true,
  state: 'open',
  answer: null,
  note: null,
  delivery: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  answeredAt: null,
}

function fakeTether(answers: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  return {
    calls,
    client: {
      request: async <T>(method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body })
        return { status: 200, body: (answers[`${method} ${path}`] ?? {}) as T }
      },
      getSession: async () => ({ displayTitle: 'Disk merge & history', label: 'Session 3' }),
    },
  }
}

describe('validateAsk', () => {
  it('takes what Tether sends and refuses anything else', () => {
    expect(validateAsk(ASK)).toEqual(ASK)
    expect(validateAsk({ ...ASK, open: 'https://x.example/a' })).toMatchObject({
      open: 'https://x.example/a',
    })
    expect(validateAsk({ ...ASK, origin: 'status' })).toMatchObject({ origin: 'status' })
    expect(validateAsk({ ...ASK, origin: 'agent' })).toBeNull()
    for (const open of ['http://x.example/a', 'javascript:alert(1)', 'https://x.example/a b', 5])
      expect(validateAsk({ ...ASK, open }), String(open)).toBeNull()
    for (const patch of [
      { id: 'nope' },
      { question: 'two\nlines' },
      { options: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { recommended: 2 },
      { state: 'gone' },
      { body: 'bell\u0007' },
      { session: null, requester: null },
      { answer: 'x'.repeat(101) },
      { launcher: 'not-a-session' },
      { answerTo: 12345678 },
    ])
      expect(validateAsk({ ...ASK, ...patch }), JSON.stringify(patch)).toBeNull()
  })
})

describe('where the answer goes (Tether API 17)', () => {
  it('passes launcher and answerTo through, and leaves them out for an older Tether', () => {
    const routed = { ...ASK, launcher: '89abcdef', answerTo: '89abcdef' }
    expect(validateAsk(routed)).toEqual(routed)
    expect(validateAsk({ ...ASK, launcher: null, answerTo: null })).toMatchObject({
      launcher: null,
      answerTo: null,
    })
    const older = validateAsk(ASK)
    expect(older && 'answerTo' in older).toBe(false)
    expect(older && 'launcher' in older).toBe(false)
  })
})

describe('the push', () => {
  it('pushes a new blocking ask once, naming the session and linking to it', async () => {
    const { sink, received } = recorder()
    const asks = new Asks({
      tether: fakeTether().client as never,
      publicHost: 'aico.example',
      notices: sink,
    })
    await asks.receive({ ask: ASK, created: true })
    await asks.receive({ ask: ASK, created: true })
    await asks.receive({ ask: { ...ASK, id: '111111111111', blocking: false }, created: true })
    await asks.receive({ ask: { ...ASK, id: '222222222222' }, created: false })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(askNotice(ASK, 'Disk merge & history', 'aico.example'))
    expect(received[0]).toEqual({
      v: 1,
      source: 'aico',
      kind: 'question',
      severity: 'warning',
      title: 'An agent is waiting on you',
      body: '“Disk merge & history” has a question for you. Open Aico to answer it.',
      key: 'ask:abcdefabcdef',
      push: 'phone',
      interrupt: 'needs-you',
      open: 'https://aico.example/?ask=abcdefabcdef',
      actions: ['answer'],
      primary: 'answer',
    })
    expect(JSON.stringify(received[0])).not.toContain(ASK.question)
  })

  it('resolves the notice when a blocking ask is answered or withdrawn', async () => {
    const { sink, resolved } = recorder()
    const asks = new Asks({
      tether: fakeTether().client as never,
      publicHost: 'aico.example',
      notices: sink,
    })
    await asks.receive({ ask: { ...ASK, state: 'answered' }, created: false })
    await asks.receive({ ask: { ...ASK, id: '111111111111', state: 'withdrawn' }, created: false })
    await asks.receive({ ask: ASK, created: false })
    await asks.receive({ ask: { ...ASK, blocking: false, state: 'answered' }, created: false })
    expect(resolved).toEqual([
      ['aico', 'ask:abcdefabcdef', 'The ask was answered.'],
      ['aico', 'ask:111111111111', 'The ask was withdrawn.'],
    ])
  })

  it('counts attached files in the push but never names them', () => {
    const attached = [
      { path: '/srv/a/plan.md', name: 'plan.md', kind: 'file', size: 120 },
      { path: '/srv/a/gone.png', name: 'gone.png', kind: 'missing', size: null },
    ] as Ask['attached']
    const body = askNotice({ ...ASK, attached }, 'nightly', null).body
    expect(body).toBe(
      '“nightly” has a question for you, with 2 files to look at. Open Aico to answer it.',
    )
    expect(body).not.toContain('plan.md')
  })

  it('passes attached files through and refuses malformed ones', () => {
    const attached = [{ path: '/srv/a/plan.md', name: 'plan.md', kind: 'file', size: 120 }]
    expect(validateAsk({ ...ASK, attached })?.attached).toEqual(attached)
    const { attached: _, ...older } = ASK
    expect(validateAsk(older)?.attached).toEqual([])
    expect(validateAsk({ ...ASK, attached: [{ ...attached[0], path: 'plan.md' }] })).toBeNull()
    expect(validateAsk({ ...ASK, attached: [{ ...attached[0], kind: 'link' }] })).toBeNull()
  })

  it('names the requester of an ask without a session', () => {
    expect(askNotice({ ...ASK, session: null, requester: 'nightly' }, 'nightly', null).body).toBe(
      '“nightly” has a question for you. Open Aico to answer it.',
    )
  })
})

describe('asks from a linked host', () => {
  const REMOTE: Ask = { ...ASK, id: 'aabbccddeeff', host: 'gem' }
  const AWAY: Ask = {
    ...REMOTE,
    id: 'ffeeddccbbaa',
    peer: { state: 'offline', since: 5_000, listedAt: 4_000 },
  }

  it('keeps the host and the not-live mark, and refuses a bad one', () => {
    expect(validateAsk(AWAY)).toEqual(AWAY)
    expect(validateAsk({ ...REMOTE, host: 'two\nlines' })).toBeNull()
    expect(validateAsk({ ...AWAY, peer: { state: 'offline' } })).toBeNull()
    const own = validateAsk(ASK)
    expect(own && 'host' in own).toBe(false)
  })

  it("lists every host's asks in one call and answers a remote one by its id", async () => {
    const tether = fakeTether({
      'GET /v1/asks?hosts=all': { items: [ASK, REMOTE, AWAY] },
      [`POST /v1/asks/${REMOTE.id}/done`]: { ...REMOTE, state: 'done' },
    })
    const asks = new Asks({ tether: tether.client as never, publicHost: null, notices: QUIET })
    expect((await asks.list()).map((ask) => [ask.id, ask.host, ask.peer?.state])).toEqual([
      [ASK.id, undefined, undefined],
      [REMOTE.id, 'gem', undefined],
      [AWAY.id, 'gem', 'offline'],
    ])
    // The hub routes /v1/asks/:id to the owning host; this door sends it as for its own.
    await asks.act(REMOTE.id, 'done')
    expect(tether.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/v1/asks/${REMOTE.id}/done`,
    })
  })
})

describe('list and answer', () => {
  it('lists only asks that check out and passes the answer through', async () => {
    const tether = fakeTether({
      'GET /v1/asks?hosts=all': { items: [ASK, { ...ASK, id: 'bad' }] },
      'POST /v1/asks/abcdefabcdef/answer': { ...ASK, state: 'answered', answer: 'Finish it now' },
    })
    const asks = new Asks({ tether: tether.client as never, publicHost: null, notices: QUIET })
    expect(await asks.list()).toEqual([ASK])
    expect(await asks.act('abcdefabcdef', 'answer', { option: 0, note: 'go' })).toMatchObject({
      state: 'answered',
    })
    expect(tether.calls.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/asks/abcdefabcdef/answer',
      body: { option: 0, note: 'go' },
    })
    await expect(asks.act('../x', 'done')).rejects.toMatchObject({ status: 404 })
  })
})

describe('asks that want files', () => {
  const FILE = {
    id: 'aaaaaaaaaaaa',
    name: 'odometer.jpg',
    mime: 'image/jpeg',
    size: 2048,
    path: '/data/blobs/aa/x',
    host: 'davion-sidarli',
  }

  it('checks the wanted range and the answer files, and treats an older Tether as wanting none', () => {
    const wanting = { ...ASK, wantsFiles: { min: 1, max: 3, hint: 'odometer' }, files: [FILE] }
    expect(validateAsk(wanting)).toEqual(wanting)
    const { wantsFiles: _w, files: _f, ...older } = ASK
    expect(validateAsk(older)).toMatchObject({ wantsFiles: null, files: [] })
    for (const patch of [
      { wantsFiles: { min: 3, max: 2, hint: null } },
      { wantsFiles: { min: 0, max: 21, hint: null } },
      { wantsFiles: { min: 0, max: 0, hint: null } },
      { wantsFiles: { min: 1, max: 2, hint: 'two\nlines' } },
      { wantsFiles: 'some' },
      { files: [{ ...FILE, id: 'nope' }] },
      { files: [{ ...FILE, size: -1 }] },
      { files: [{ ...FILE, path: 5 }] },
      { files: 'a.jpg' },
    ])
      expect(validateAsk({ ...ASK, ...patch }), JSON.stringify(patch)).toBeNull()
  })

  /** An ask that wants 1 to 2 files, a captures store with files tagged to it, and a fake Tether. */
  function setup(ask: Partial<Ask> = {}) {
    const wanting: Ask = { ...ASK, wantsFiles: { min: 1, max: 2, hint: null }, ...ask }
    const notes = new NotesStore(':memory:', { hostName: 'door' })
    const add = (name: string, askId: string | null, hash: string | null = 'a'.repeat(64)) =>
      notes.insertCapture({
        clientId: `client-${name}`,
        askId,
        kind: 'image',
        name,
        mime: 'image/jpeg',
        size: 10,
        hash: hash ?? 'a'.repeat(64),
      }).capture
    const tether = fakeTether({
      [`GET /v1/asks/${wanting.id}`]: wanting,
      [`POST /v1/asks/${wanting.id}/answer`]: { ...wanting, state: 'answered' },
    })
    const asks = new Asks({
      tether: tether.client as never,
      publicHost: null,
      notices: QUIET,
      files: { store: notes, blobsDir: '/data/blobs', hostName: 'door' },
    })
    return { asks, notes, tether, add, ask: wanting }
  }
  const answers = (tether: ReturnType<typeof fakeTether>) =>
    tether.calls.filter((call) => call.method === 'POST')

  it('forwards the files with their path on this host', async () => {
    const { asks, tether, add, ask } = setup()
    const one = add('odometer.jpg', ask.id)
    const two = add('dash.jpg', ask.id, 'b'.repeat(64))
    await asks.answer(ask.id, { files: [one.id, two.id], note: 'both' })
    expect(answers(tether)).toEqual([
      {
        method: 'POST',
        path: `/v1/asks/${ask.id}/answer`,
        body: {
          note: 'both',
          files: [
            {
              id: one.id,
              name: 'odometer.jpg',
              mime: 'image/jpeg',
              size: 10,
              path: `/data/blobs/aa/${'a'.repeat(64)}`,
              host: 'door',
            },
            {
              id: two.id,
              name: 'dash.jpg',
              mime: 'image/jpeg',
              size: 10,
              path: `/data/blobs/bb/${'b'.repeat(64)}`,
              host: 'door',
            },
          ],
        },
      },
    ])
  })

  it('cleans a file name Tether would refuse', async () => {
    const { asks, tether, add, ask } = setup()
    const odd = add('re\u200bceipt\u202e.jpg', ask.id)
    await asks.answer(ask.id, { files: [odd.id] })
    expect(answers(tether)[0]?.body).toMatchObject({ files: [{ name: 'receipt.jpg' }] })
  })

  it('refuses a capture from another ask, a missing one and a deleted one', async () => {
    const { asks, tether, add, notes, ask } = setup()
    const other = add('other.jpg', 'ffffffffffff')
    const untagged = add('loose.jpg', null)
    const deleted = add('gone.jpg', ask.id)
    notes.tombstoneCapture(deleted.id)
    for (const id of [other.id, untagged.id, deleted.id, '0123456789ab', 'nope'])
      await expect(asks.answer(ask.id, { files: [id] }), id).rejects.toMatchObject({ status: 422 })
    expect(answers(tether)).toEqual([])
  })

  it('refuses more than the ask wants, files on an ask that wants none, and a closed ask', async () => {
    const { asks, add, ask } = setup()
    const ids = [1, 2, 3].map((n) => add(`f${n}.jpg`, ask.id).id)
    await expect(asks.answer(ask.id, { files: ids })).rejects.toMatchObject({ status: 409 })

    const none = setup({ wantsFiles: null })
    await expect(
      none.asks.answer(none.ask.id, { files: [none.add('a.jpg', none.ask.id).id] }),
    ).rejects.toThrow(/does not take files/)

    const closed = setup({ state: 'withdrawn' })
    const kept = closed.add('a.jpg', closed.ask.id)
    await expect(closed.asks.answer(closed.ask.id, { files: [kept.id] })).rejects.toThrow(
      /closed\. Your files are kept in Captures/,
    )
    expect(answers(closed.tether)).toEqual([])
    // The capture stays, tagged with the ask.
    expect(closed.notes.capturesForAsk(closed.ask.id).map((c) => c.id)).toEqual([kept.id])
  })

  it('sends a double submit once', async () => {
    const { asks, tether, add, ask } = setup()
    const file = add('a.jpg', ask.id)
    const [first, second] = await Promise.allSettled([
      asks.answer(ask.id, { files: [file.id] }),
      asks.answer(ask.id, { files: [file.id] }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    expect(answers(tether)).toHaveLength(1)
    // A second tap after the first landed, with the same files, is not sent again.
    const landed = setup({ state: 'answered' })
    const same = landed.add('a.jpg', landed.ask.id)
    landed.ask.files = [
      { id: same.id, name: 'a.jpg', mime: 'image/jpeg', size: 10, path: null, host: null },
    ]
    await landed.asks.answer(landed.ask.id, { files: [same.id] })
    expect(answers(landed.tether)).toEqual([])
  })

  it('answers without the files: the note goes alone, or a plain "No files"', async () => {
    const { asks, tether, ask } = setup()
    await asks.answer(ask.id, { note: 'not today', skippedFiles: true })
    await asks.answer(ask.id, { skippedFiles: true })
    expect(answers(tether).map((call) => call.body)).toEqual([
      { note: 'not today' },
      { text: 'No files' },
    ])
  })
})

describe('an ask with a minimum is not answered below it', () => {
  const ask = {
    ...ASK,
    options: ['Yes, works', 'No, problem'],
    wantsFiles: { min: 2, max: 5, hint: null },
  }
  function setup() {
    const notes = new NotesStore(':memory:', { hostName: 'door' })
    const tether = fakeTether({
      [`GET /v1/asks/${ask.id}`]: ask,
      [`POST /v1/asks/${ask.id}/answer`]: { ...ask, state: 'answered' },
    })
    const asks = new Asks({
      tether: tether.client as never,
      publicHost: null,
      notices: QUIET,
      files: { store: notes, blobsDir: '/data/blobs', hostName: 'door' },
    })
    const add = (name: string) =>
      notes.insertCapture({
        clientId: `client-${name}`,
        askId: ask.id,
        kind: 'image',
        name,
        mime: 'image/jpeg',
        size: 10,
        hash: 'a'.repeat(64),
      }).capture.id
    const posts = () => tether.calls.filter((call) => call.method === 'POST')
    return { asks, add, posts }
  }

  it('refuses a choice with no files, however it is sent, and says what is missing', async () => {
    const { asks, posts } = setup()
    for (const reply of [
      { option: 0 },
      { option: 0, skippedFiles: true },
      { option: 0, files: [] },
    ])
      await expect(asks.answer(ask.id, reply), JSON.stringify(reply)).rejects.toMatchObject({
        status: 409,
        detail: 'This question needs at least 2 files. None are saved yet.',
      })
    expect(posts()).toEqual([])
  })

  it('refuses one file of two, then answers once there are two, carrying both', async () => {
    const { asks, add, posts } = setup()
    const one = add('a.jpg')
    await expect(asks.answer(ask.id, { option: 0, files: [one] })).rejects.toMatchObject({
      status: 409,
      detail: 'This question needs at least 2 files. Only 1 saved so far; add 1 more.',
    })
    expect(posts()).toEqual([])
    const two = add('b.jpg')
    await asks.answer(ask.id, { option: 0, files: [one, two] })
    expect(posts()).toHaveLength(1)
    const sent = posts()[0]?.body as { files: { id: string }[] }
    expect(sent.files.map((f) => f.id)).toEqual([one, two])
  })

  it('lets a plain decline through: Not now is not an answer with files missing', async () => {
    const { asks, posts } = setup()
    await asks.answer(ask.id, { text: 'Not now', skippedFiles: true })
    expect(posts().map((call) => call.body)).toEqual([{ text: 'Not now' }])
  })

  it('a decline keeps what the owner typed, and only then may go below the minimum', async () => {
    const { asks, posts } = setup()
    await expect(asks.answer(ask.id, { note: 'no camera here' })).rejects.toThrow(/at least/)
    await asks.answer(ask.id, { text: 'Not now', note: 'no camera here', skippedFiles: true })
    expect(posts().map((call) => call.body)).toEqual([{ text: 'Not now', note: 'no camera here' }])
  })
})

describe('Aico grant taps', () => {
  it('keeps empty and unavailable grant feeds distinct without touching the real socket', async () => {
    const options = { tether: fakeTether().client as never, publicHost: null }
    const empty = new Asks({ ...options, notices: QUIET, pendingGrants: async () => [] })
    const unavailable = new Asks({ ...options, notices: QUIET, pendingGrants: async () => null })
    expect(await empty.approvals()).toEqual([])
    expect(await unavailable.approvals()).toBeNull()
  })
})

describe('asks from a chat another session started', () => {
  const STARTER = '89abcdef'
  const starterOf = (ask: Ask) => (ask.session === ASK.session ? STARTER : null)
  const pushes = () => {
    const { sink, received } = recorder()
    return { runs: received, notices: sink }
  }

  it('tells the starting session, keeps it from the owner and sends no push', async () => {
    const tether = fakeTether({
      'GET /v1/asks?hosts=all': {
        items: [ASK, { ...ASK, id: '111111111111', session: '99999999' }],
      },
    })
    const { runs, notices } = pushes()
    const asks = new Asks({
      tether: tether.client as never,
      publicHost: 'aico.example',
      notices,
      starterOf,
      answerUrl: 'http://127.0.0.1:1',
    })
    await asks.receive({ ask: ASK, created: true })
    expect(runs).toEqual([])
    const sent = tether.calls.find((call) => call.path === `/v1/sessions/${STARTER}/deliveries`)
    const body = sent?.body as { source: string; line: string }
    expect(body.source).toBe(`aico:chat-ask-${ASK.id}`)
    expect(body.line).toContain(ASK.question)
    expect(body.line).toContain(`/api/asks/${ASK.id}/answer`)
    expect(asks.snapshot().asks).toEqual([])
    // The owner's own chats keep their asks.
    expect((await asks.list()).map((ask) => ask.id)).toEqual(['111111111111'])
  })

  it('falls back to the owner when the starting session cannot take the line', async () => {
    const tether = fakeTether()
    const failing = {
      request: async (method: string, path: string) => {
        if (path.endsWith('/deliveries')) throw new Error('gone')
        return tether.client.request(method, path)
      },
    }
    const { runs, notices } = pushes()
    const asks = new Asks({ tether: failing as never, publicHost: null, notices, starterOf })
    await asks.receive({ ask: ASK, created: true })
    expect(runs).toHaveLength(1)
    expect(asks.snapshot().asks.map((ask) => ask.id)).toEqual([ASK.id])
  })
})
