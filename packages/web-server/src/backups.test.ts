import { describe, expect, it } from 'vitest'
import { FRESH_MS, registerBackupRoutes, STALE_MS } from './backups'
import { Router } from './http'

function setup() {
  let clock = 1_000_000
  const calls: string[][] = []
  let answer: () => Promise<unknown> = async () => ({ entries: [calls.length] })
  const router = new Router()
  registerBackupRoutes(
    router,
    async (args) => {
      calls.push(args)
      return args[0] === 'list' ? answer() : { message: 'queued' }
    },
    () => clock,
  )
  const get = async () => {
    let body = ''
    const res = {
      statusCode: 0,
      setHeader() {},
      writeHead(code: number) {
        this.statusCode = code
      },
      end(text: string) {
        body = text
      },
    }
    await router.handle(
      { method: 'GET', headers: {} } as never,
      res as never,
      new URL('http://x/api/backups'),
    )
    return { status: res.statusCode, body: body ? JSON.parse(body) : null }
  }
  return {
    calls,
    get,
    advance: (ms: number) => {
      clock += ms
    },
    fail: () => {
      answer = async () => {
        throw new Error('ssh down')
      }
    },
    router,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('backups listing', () => {
  it('answers a young listing without asking again', async () => {
    const t = setup()
    await t.get()
    t.advance(FRESH_MS - 1)
    await t.get()
    expect(t.calls).toHaveLength(1)
  })

  it('answers an older listing at once and refreshes behind it', async () => {
    const t = setup()
    const first = await t.get()
    t.advance(FRESH_MS + 1)
    const second = await t.get()
    expect(second.body).toEqual(first.body)
    await settle()
    expect(t.calls).toHaveLength(2)
    expect((await t.get()).body).toEqual({ entries: [2] })
  })

  it('keeps the last listing when a refresh fails, until it is too old', async () => {
    const t = setup()
    const first = await t.get()
    t.fail()
    t.advance(FRESH_MS + 1)
    expect((await t.get()).body).toEqual(first.body)
    await settle()
    t.advance(STALE_MS)
    expect((await t.get()).status).toBe(500)
  })
})
