import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runPhonesCli } from './phones-cli'

it('lists metadata and removes one exact phone through the owning API', async () => {
  const calls: { url: string; method: string | undefined }[] = []
  const output: string[] = []
  const io = {
    out: (s: string) => output.push(s),
    err: (s: string) => output.push(s),
    baseUrl: 'http://127.0.0.1:1',
    fetch: async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), method: options?.method })
      return new Response(
        JSON.stringify(
          options?.method === 'DELETE'
            ? { removed: true }
            : { phones: [{ id: 'test-phone', name: 'Test phone', last_ack: null }] },
        ),
      )
    },
  }
  expect(await runPhonesCli(['list'], io)).toBe(0)
  expect(output.join('')).toContain('ID          NAME\ntest-phone  Test phone')
  expect(await runPhonesCli(['remove', 'test-phone'], io)).toBe(0)
  expect(calls[1]).toEqual({ url: 'http://127.0.0.1:1/api/phone-app/test-phone', method: 'DELETE' })
  expect(await runPhonesCli(['remove', '../wrong'], io)).toBe(2)
  expect(calls).toHaveLength(2)
})

it("answers a sync: merges the sender's phones, keeps its own until confirmed, merges the canary cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phones-cli-'))
  try {
    const devicesFile = join(dir, 'phones.json')
    const canaryFolder = join(dir, 'canary')
    const phone = (id: string, added_at: number) => ({
      id,
      sig_pub: 's',
      enc_pub: 'e',
      auth: 'a',
      added_at,
    })
    writeFileSync(devicesFile, JSON.stringify([phone('here', 10)]))
    const out: string[] = []
    const run = (verb: string, input: unknown) =>
      runPhonesCli([verb], {
        out: (s) => out.push(s),
        err: (s) => out.push(s),
        baseUrl: 'http://127.0.0.1:1',
        fetch,
        readInput: async () => JSON.stringify(input),
        devicesFile,
        canaryFolder,
      })
    expect(await run('merge', [phone('sent', 1)])).toBe(0)
    expect(JSON.parse(out.pop() as string).map((p: { id: string }) => p.id)).toEqual([
      'sent',
      'here',
    ])
    // No confirm yet: the phone paired here is still kept.
    expect(await run('merge', [phone('sent', 1)])).toBe(0)
    expect(JSON.parse(out.pop() as string)).toHaveLength(2)
    expect(await run('merge-done', null)).toBe(0)
    expect(await run('merge', [phone('sent', 1)])).toBe(0)
    expect(JSON.parse(out.pop() as string).map((p: { id: string }) => p.id)).toEqual(['sent'])

    mkdirSync(canaryFolder)
    writeFileSync(join(canaryFolder, 'poll.json'), JSON.stringify({ a: 5, b: 9 }))
    expect(await run('canary-merge', { a: 7, c: 1 })).toBe(0)
    expect(JSON.parse(out.pop() as string)).toEqual({ a: 7, b: 9, c: 1 })
    expect(await run('canary-merge', [])).toBe(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
