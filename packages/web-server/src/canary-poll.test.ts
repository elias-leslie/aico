import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CanaryEvents } from './canary'
import { CanaryPoller, mergeCursorFile, type PollHit } from './canary-poll'

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

const HOUR = 3600_000
const registry = {
  tokens: [
    { token: 't1', auth: 'a1', name: 'Decoy', path: 'p', type: 'web', kind: 'canarytokens' },
  ],
}

function pollerAt(folder: string, hits: () => PollHit[], now: () => number, notices: unknown[]) {
  return new CanaryPoller(
    folder,
    {
      receive: (notice) => {
        notices.push(notice)
        return {} as never
      },
    },
    new CanaryEvents(folder),
    'https://tokens.example/api',
    async () => ({ history: { hits: hits() } }),
    now,
  )
}

it('a machine back after weeks waits for the other cursor and does not alert old hits again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'canary-poll-'))
  try {
    writeFileSync(join(folder, 'registry.json'), JSON.stringify(registry))
    // This machine's own cursor is weeks old; the other machine already alerted up to hit 500.
    writeFileSync(join(folder, 'poll.json'), JSON.stringify({ t1: 100 }))
    const weeksAgo = new Date(Date.now() - 20 * 24 * HOUR)
    utimesSync(join(folder, 'poll.json'), weeksAgo, weeksAgo)
    const hits = [
      { time_of_hit: 200, src_ip: '192.0.2.1' },
      { time_of_hit: 500, src_ip: '192.0.2.2' },
      { time_of_hit: 600, src_ip: '192.0.2.3' },
    ]
    let now = Date.now()
    const notices: unknown[] = []
    const poller = pollerAt(
      folder,
      () => hits,
      () => now,
      notices,
    )
    // Just started: held, nothing alerts and the cursor is untouched.
    expect(await poller.poll()).toMatchObject({ held: true, alerts: 0 })
    expect(notices).toHaveLength(0)
    // The sync brings the other machine's cursor (and answers with the merged one).
    expect(mergeCursorFile(folder, { t1: 500 })).toEqual({ t1: 500 })
    // Only the hit since the other machine's last look alerts.
    expect(await poller.poll()).toMatchObject({ alerts: 1 })
    expect(notices).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(folder, 'poll.json'), 'utf8'))).toEqual({ t1: 600 })
    // No sync ever came (the other machine is off): after the grace it polls on its own cursor.
    writeFileSync(join(folder, 'poll.json'), JSON.stringify({ t1: 100 }))
    utimesSync(join(folder, 'poll.json'), weeksAgo, weeksAgo)
    expect(await poller.poll()).toMatchObject({ held: true })
    now += 16 * 60_000
    expect(await poller.poll()).toMatchObject({ alerts: 3 })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('a sync landing while a pass runs is not overwritten by that pass', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'canary-poll-'))
  try {
    writeFileSync(join(folder, 'registry.json'), JSON.stringify(registry))
    writeFileSync(join(folder, 'poll.json'), JSON.stringify({ t1: 100, other: 7 }))
    const notices: unknown[] = []
    const poller = pollerAt(
      folder,
      () => {
        mergeCursorFile(folder, { t1: 300, other: 9, fresh: 1 })
        return [{ time_of_hit: 200, src_ip: '192.0.2.1' }]
      },
      Date.now,
      notices,
    )
    await poller.poll()
    expect(JSON.parse(readFileSync(join(folder, 'poll.json'), 'utf8'))).toEqual({
      t1: 300,
      other: 9,
      fresh: 1,
    })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
