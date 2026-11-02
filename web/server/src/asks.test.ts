// Owner asks in the web server: Tether's asks checked again, one push per new
// blocking ask naming the session (never the question), the answer passed
// through, and Nightshift's pending taps as links.

import { describe, expect, it } from 'vitest'
import { type Ask, Asks, askNotice, parsePending, validateAsk } from './asks'
import { NotesStore } from './notes-db'

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
    const runs: string[][] = []
    const asks = new Asks({
      tether: fakeTether().client as never,
      publicHost: 'aico.example',
      run: async (argv, _t, input) => {
        runs.push(input === undefined ? argv : [...argv, input])
        return ''
      },
    })
    await asks.receive({ ask: ASK, created: true })
    await asks.receive({ ask: ASK, created: true })
    await asks.receive({ ask: { ...ASK, id: '111111111111', blocking: false }, created: true })
    await asks.receive({ ask: { ...ASK, id: '222222222222' }, created: false })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.slice(0, 3)).toEqual(['nightshift', 'push', '--json'])
    expect(runs[0]?.[3]).toBe(
      JSON.stringify(askNotice(ASK, 'Disk merge & history', 'aico.example')),
    )
    expect(JSON.parse(String(runs[0]?.[3]))).toEqual({
      v: 1,
      source: 'aico',
      kind: 'question',
      severity: 'warning',
      title: 'An agent is waiting on you',
      body: '“Disk merge & history” has a question for you. Open Aico to answer it.',
      key: 'ask:abcdefabcdef',
      push: 'phone',
      open: 'https://aico.example/?ask=abcdefabcdef',
      actions: ['answer'],
      primary: 'answer',
    })
    expect(runs[0]?.[3]).not.toContain(ASK.question)
  })

  it('resolves the notice when a blocking ask is answered or withdrawn', async () => {
    const runs: string[][] = []
    const asks = new Asks({
      tether: fakeTether().client as never,
      publicHost: 'aico.example',
      run: async (argv, _t, input) => {
        runs.push(input === undefined ? argv : [...argv, input])
        return ''
      },
    })
    await asks.receive({ ask: { ...ASK, state: 'answered' }, created: false })
    await asks.receive({ ask: { ...ASK, id: '111111111111', state: 'withdrawn' }, created: false })
    await asks.receive({ ask: ASK, created: false })
    await asks.receive({ ask: { ...ASK, blocking: false, state: 'answered' }, created: false })
    expect(runs).toEqual([
      ['nightshift', 'resolve', 'ask:abcdefabcdef', '--text', 'The ask was answered.'],
      ['nightshift', 'resolve', 'ask:111111111111', '--text', 'The ask was withdrawn.'],
    ])
  })

  it('names the requester of an ask without a session', () => {
    expect(askNotice({ ...ASK, session: null, requester: 'nightly' }, 'nightly', null).body).toBe(
      '“nightly” has a question for you. Open Aico to answer it.',
    )
  })
})

describe('list and answer', () => {
  it('lists only asks that check out and passes the answer through', async () => {
    const tether = fakeTether({
      'GET /v1/asks': { items: [ASK, { ...ASK, id: 'bad' }] },
      'POST /v1/asks/abcdefabcdef/answer': { ...ASK, state: 'answered', answer: 'Finish it now' },
    })
    const asks = new Asks({ tether: tether.client as never, publicHost: null, run: async () => '' })
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
      run: async () => '',
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

describe('Nightshift approvals', () => {
  it('keeps https taps as links', () => {
    expect(
      parsePending(
        JSON.stringify({
          taps: [
            {
              id: 'n1',
              title: 'GitHub admin for 15 min',
              url: 'https://ns.example/n/n1',
              expires_in_s: 840.4,
            },
            { id: 'n2', title: 'Bad link', url: 'javascript:alert(1)', expires_in_s: 10 },
          ],
        }),
      ),
    ).toEqual([
      {
        id: 'n1',
        title: 'GitHub admin for 15 min',
        url: 'https://ns.example/n/n1',
        expiresInS: 840,
      },
    ])
    expect(parsePending('{"taps": []}')).toEqual([])
    expect(parsePending('not json')).toBeNull()
  })

  it('reads as unavailable when nightshift fails', async () => {
    const asks = new Asks({
      tether: fakeTether().client as never,
      publicHost: null,
      run: async () => {
        throw new Error('not found')
      },
    })
    expect(await asks.approvals()).toBeNull()
  })
})
