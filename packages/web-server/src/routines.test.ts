import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Router } from './http'
import { ROUTINES_FRESH_MS, registerRoutineRoutes } from './routines'

function setup() {
  let clock = 1_000_000
  const calls: string[][] = []
  const router = new Router()
  registerRoutineRoutes(
    router,
    async (args) => {
      calls.push(args)
      return args[0] === 'list'
        ? JSON.stringify([{ kind: 'k', n: calls.length }])
        : `${args[0]} ${args[1]}`
    },
    () => clock,
  )
  const call = async (method: string, path: string, body?: unknown) => {
    let text = ''
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code: number) {
        this.statusCode = code
      },
      end(chunk: string) {
        text = chunk
      },
    }
    const req = Object.assign(
      Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
      {
        method,
        headers: {},
      },
    )
    await router.handle(req as never, res as never, new URL(`http://x${path}`))
    return { status: res.statusCode, body: text ? JSON.parse(text) : null }
  }
  return {
    calls,
    call,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('routines routes', () => {
  it('lists through aico routines list and reuses a young listing', async () => {
    const t = setup()
    expect((await t.call('GET', '/api/routines')).body).toEqual({ routines: [{ kind: 'k', n: 1 }] })
    t.advance(ROUTINES_FRESH_MS - 1)
    await t.call('GET', '/api/routines')
    expect(t.calls).toEqual([['list', '--json']])
    t.advance(2)
    expect((await t.call('GET', '/api/routines')).body).toEqual({ routines: [{ kind: 'k', n: 2 }] })
  })

  it('runs, pauses and resumes by kind, and refuses a kind that is not one', async () => {
    const t = setup()
    await t.call('GET', '/api/routines')
    for (const verb of ['run', 'pause', 'resume'])
      expect(
        (await t.call('POST', `/api/routines/${verb}`, { kind: 'school-check' })).body,
      ).toEqual({
        message: `${verb} school-check`,
      })
    expect(t.calls.slice(1)).toEqual([
      ['run', 'school-check'],
      ['pause', 'school-check'],
      ['resume', 'school-check'],
    ])
    expect((await t.call('POST', '/api/routines/run', { kind: '--machine x' })).status).toBe(422)
    expect((await t.call('POST', '/api/routines/run', {})).status).toBe(422)
    // A change drops the young listing so the page reads the new state.
    await t.call('GET', '/api/routines')
    expect(t.calls.filter((c) => c[0] === 'list')).toHaveLength(2)
  })
})
