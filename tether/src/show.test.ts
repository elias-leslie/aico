import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callSocket } from './client'
import { resolvePaths, resolveShowConfig, type TetherPaths } from './config'
import { type RunningDaemon, startDaemon } from './daemon'
import { ShareStore } from './show'
import { Store } from './store'

let dir: string
let paths: TetherPaths
let daemon: RunningDaemon

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-show-'))
  paths = resolvePaths({
    instance: 'test',
    env: { HOME: dir, TETHER_STATE_DIR: join(dir, 'state'), TETHER_RUNTIME_DIR: join(dir, 'run') },
  })
  daemon = await startDaemon(paths, {
    HOME: dir,
    TETHER_SUMMITFLOW_URL: 'off',
    TETHER_RECONCILE: 'off',
  })
  await daemon.ready
})

afterEach(async () => {
  await daemon.close()
  rmSync(dir, { recursive: true, force: true })
})

const show = (body: unknown) => callSocket(paths.socket, 'POST', '/v1/show', body)
const listed = async () =>
  ((await callSocket(paths.socket, 'GET', '/v1/shares')).body as { items: unknown[] }).items

describe('POST /v1/show', () => {
  it('publishes and keeps a link', async () => {
    const result = await show({
      session: '0123abcd',
      title: 'Review this page',
      url: 'https://example.com/report?q=one#two',
    })
    expect(result.status).toBe(201)
    expect(result.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      session: '0123abcd',
      title: 'Review this page',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      kind: 'url',
      url: 'https://example.com/report?q=one#two',
    })
    expect(daemon.events.replay(0)).toEqual([
      expect.objectContaining({ type: 'show.requested', data: result.body }),
    ])
    expect(await listed()).toEqual([result.body])
  })

  it('shares files and folders where they are, by their real paths, copying nothing', async () => {
    const work = join(dir, 'work')
    mkdirSync(join(work, 'out'), { recursive: true })
    writeFileSync(join(work, 'image.png'), 'png')
    writeFileSync(join(work, 'prompt.md'), 'prompt')
    symlinkSync(join(work, 'prompt.md'), join(dir, 'prompt-link.md'))
    const before = readdirSync(dir, { recursive: true }).sort()
    const result = await show({
      paths: [
        join(work, 'image.png'),
        join(dir, 'prompt-link.md'),
        join(work, 'out'),
        join(work, 'prompt.md'),
      ],
      title: 'Image and prompt',
    })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({
      session: null,
      kind: 'files',
      title: 'Image and prompt',
      paths: [join(work, 'image.png'), join(work, 'prompt.md'), `${join(work, 'out')}/`],
    })
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before)
    expect(await listed()).toEqual([result.body])
  })

  it('accepts a single path', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'notes')
    expect(await show({ path: join(dir, 'notes.txt') })).toMatchObject({
      status: 201,
      body: { kind: 'files', paths: [join(dir, 'notes.txt')] },
    })
  })

  it('refuses missing paths and special files without publishing', async () => {
    writeFileSync(join(dir, 'good'), 'good')
    for (const path of [join(dir, 'missing'), '/dev/null']) {
      expect(await show({ paths: [join(dir, 'good'), path] })).toMatchObject({
        status: 400,
        body: { error: 'invalid_path' },
      })
    }
    expect(daemon.events.lastSeq).toBe(0)
    expect(await listed()).toEqual([])
  })

  it.each([
    {},
    { url: 'https://example.com', path: '/tmp/a' },
    { path: '/tmp/a', paths: ['/tmp/b'] },
    { paths: [] },
    { paths: '/tmp/a' },
    { paths: ['relative'] },
    { paths: Array.from({ length: 21 }, (_, index) => `/tmp/${index}`) },
    { url: null },
    { path: 123 },
    { path: 'relative' },
    { path: '/a\nb' },
    { url: 'file:///tmp/a' },
    { url: 'javascript:alert(1)' },
    { url: 'ftp://example.com' },
    { url: 'https://' },
    { url: 'https:example.com' },
    { url: ' https://example.com' },
    { url: 'https://example.com/\nsecret' },
    { url: `https://example.com/${'a'.repeat(2000)}` },
    { url: 'https://example.com', session: '../outside' },
    { url: 'https://example.com', session: 'root-logical-id' },
    { url: 'https://example.com', session: null },
    { url: 'https://example.com', title: 123 },
    { url: 'https://example.com', title: '' },
    { url: 'https://example.com', title: 'a'.repeat(121) },
    { url: 'https://example.com', title: 'line\nbreak' },
    { url: 'https://example.com', title: 'esc\u001b[31m' },
    { url: 'https://example.com', title: 'bidi‮' },
    { url: 'https://example.com', extra: true },
  ])('refuses invalid requests without publishing: %j', async (body) => {
    expect(await show(body)).toMatchObject({ status: 400, body: { error: 'invalid_body' } })
    expect(daemon.events.lastSeq).toBe(0)
  })

  it('accepts HTTP and the title and URL length boundaries', async () => {
    const url = `http://example.com/${'a'.repeat(2000 - 'http://example.com/'.length)}`
    expect(await show({ url, title: 'a'.repeat(120) })).toMatchObject({ status: 201 })
  })
})

describe('ShareStore', () => {
  it('drops shares past the retention when the next one arrives', () => {
    const store = new Store(':memory:')
    try {
      const shares = new ShareStore(store.db, { retentionDays: 30 })
      const day = 24 * 60 * 60 * 1000
      const now = Date.UTC(2026, 9, 27)
      const link = { session: null, title: null, kind: 'url' as const, url: 'https://example.com' }
      const old = shares.add(link, now - 31 * day)
      const recent = shares.add(link, now - 29 * day)
      expect(shares.list().map((share) => share.id)).toEqual([old.id, recent.id])
      const latest = shares.add(link, now)
      expect(shares.list().map((share) => share.id)).toEqual([recent.id, latest.id])
    } finally {
      store.close()
    }
  })
})

describe('show configuration', () => {
  it('keeps shares 30 days by default', () => {
    expect(resolveShowConfig({})).toEqual({ retentionDays: 30 })
  })

  it.each(['0', '-1', '1.5', '', 'abc'])('rejects invalid retention %j', (value) => {
    expect(() => resolveShowConfig({ TETHER_SHARE_RETENTION_DAYS: value })).toThrow(
      /TETHER_SHARE_RETENTION_DAYS/,
    )
  })
})
