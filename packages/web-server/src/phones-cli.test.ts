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
