// Owner asks in the web server: Tether's asks checked again, one push per new
// blocking ask naming the session (never the question), the answer passed
// through, and Nightshift's pending taps as links.

import { describe, expect, it } from 'vitest'
import { type Ask, Asks, askPushArgv, parsePending, validateAsk } from './asks'

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
    ])
      expect(validateAsk({ ...ASK, ...patch }), JSON.stringify(patch)).toBeNull()
  })
})

describe('the push', () => {
  it('pushes a new blocking ask once, naming the session and linking to it', async () => {
    const runs: string[][] = []
    const asks = new Asks({
      tether: fakeTether().client as never,
      publicHost: 'aico.example',
      run: async (argv) => {
        runs.push(argv)
        return ''
      },
    })
    await asks.receive({ ask: ASK, created: true })
    await asks.receive({ ask: ASK, created: true })
    await asks.receive({ ask: { ...ASK, id: '111111111111', blocking: false }, created: true })
    await asks.receive({ ask: { ...ASK, id: '222222222222' }, created: false })
    expect(runs).toEqual([
      [
        'nightshift',
        'push',
        '--title',
        'An agent is waiting on you',
        '--severity',
        'info',
        '--key',
        'ask:abcdefabcdef',
        '--open',
        'https://aico.example/?ask=abcdefabcdef',
        '“Disk merge & history” has a question for you. Open Aico to answer it.',
      ],
    ])
    expect(runs[0]?.join(' ')).not.toContain(ASK.question)
  })

  it('names the requester of an ask without a session', () => {
    expect(
      askPushArgv({ ...ASK, session: null, requester: 'nightly' }, 'nightly', null).at(-1),
    ).toBe('“nightly” has a question for you. Open Aico to answer it.')
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
