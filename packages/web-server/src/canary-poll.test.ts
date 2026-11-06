import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CanaryEvents } from './canary'
import { CanaryPoller, type PollHit } from './canary-poll'

it('baselines a token on its first look, then alerts once for each new hit', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'canary-poll-'))
  writeFileSync(
    join(folder, 'registry.json'),
    JSON.stringify({
      tokens: [
        { token: 't1', auth: 'a1', name: 'Decoy', path: 'p', type: 'web', kind: 'canarytokens' },
        { name: 'honeypot', kind: 'opencanary', type: 'opencanary' },
      ],
    }),
  )
  let hits: PollHit[] = [{ time_of_hit: 100, src_ip: '192.0.2.1' }]
  const urls: string[] = []
  const notices: { title?: string; push?: string }[] = []
  const poller = new CanaryPoller(
    folder,
    {
      receive: (notice) => {
        notices.push(notice as never)
        return {} as never
      },
    },
    new CanaryEvents(folder),
    'https://tokens.example/api',
    async (url) => {
      urls.push(url)
      return { history: { hits } }
    },
  )
  try {
    expect(await poller.poll()).toMatchObject({ checked: 1, baselined: 1, alerts: 0 })
    expect(notices).toHaveLength(0)
    expect(urls).toEqual(['https://tokens.example/api/history?token=t1&auth=a1'])
    hits = [...hits, { time_of_hit: 200, src_ip: '192.0.2.9' }]
    expect(await poller.poll()).toMatchObject({ alerts: 1 })
    expect(await poller.poll()).toMatchObject({ alerts: 0 })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ title: 'Canary tripped: Decoy', push: 'phone' })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
