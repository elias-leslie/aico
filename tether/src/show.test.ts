import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callSocket } from './client'
import { resolvePaths, resolveShowConfig, type TetherPaths } from './config'
import { type RunningDaemon, startDaemon } from './daemon'

vi.mock('node:fs/promises', { spy: true })

let dir: string
let root: string
let paths: TetherPaths
let daemon: RunningDaemon

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-show-'))
  root = join(dir, 'exchange')
  mkdirSync(root)
  paths = resolvePaths({
    instance: 'test',
    env: { HOME: dir, TETHER_STATE_DIR: join(dir, 'state'), TETHER_RUNTIME_DIR: join(dir, 'run') },
  })
  daemon = await startDaemon(paths, {
    HOME: dir,
    TETHER_SUMMITFLOW_URL: 'off',
    TETHER_RECONCILE: 'off',
    TETHER_EXCHANGE_ROOT: root,
    TETHER_SHOW_MAX_BYTES: '32',
  })
  await daemon.ready
})

afterEach(async () => {
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(open)
  await daemon.close()
  rmSync(dir, { recursive: true, force: true })
})

const show = (body: unknown) => callSocket(paths.socket, 'POST', '/v1/show', body)

describe('POST /v1/show', () => {
  it('publishes a URL without requiring an exchange root or an existing session', async () => {
    rmSync(root, { recursive: true })
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
      kind: 'url',
      name: 'https://example.com/report?q=one#two',
      url: 'https://example.com/report?q=one#two',
    })
    expect(daemon.events.replay(0)).toEqual([
      expect.objectContaining({ type: 'show.requested', data: result.body }),
    ])
    expect(existsSync(root)).toBe(false)
  })

  it('copies a file with a safe bounded name relative to the agent exchange root', async () => {
    const source = join(dir, `a strange 名 ${'z'.repeat(100)}.txt`)
    writeFileSync(source, 'private source contents', { mode: 0o600 })
    const result = await show({ session: '0123abcd', path: source, title: 'A report' })
    expect(result.status).toBe(201)
    const data = result.body as Record<string, string>
    expect(data.name).toMatch(/^0123abcd\/out\/[0-9a-f]{12}-[A-Za-z0-9._-]{80}$/)
    expect(basename(data.name ?? '').startsWith(`${data.id}-`)).toBe(true)
    const copied = join(root, 'agent', data.name ?? '')
    expect(readFileSync(copied, 'utf8')).toBe('private source contents')
    expect(statSync(copied).mode & 0o777).toBe(0o644)
    for (const part of ['agent', 'agent/0123abcd', 'agent/0123abcd/out']) {
      expect(statSync(join(root, part)).mode & 0o777).toBe(0o755)
    }
    writeFileSync(source, 'changed')
    expect(readFileSync(copied, 'utf8')).toBe('private source contents')
    expect(daemon.events.replay(0)).toEqual([
      expect.objectContaining({ type: 'show.requested', data: result.body }),
    ])
    expect(JSON.stringify(result.body)).not.toContain('private source contents')
    expect(result.body).not.toHaveProperty('path')
    expect(result.body).not.toHaveProperty('url')
  })

  it('uses none for an absent session and accepts empty files and the exact size cap', async () => {
    const source = join(dir, 'report.txt')
    for (const size of [0, 32]) {
      writeFileSync(source, 'x'.repeat(size))
      const result = await show({ path: source })
      expect(result.status).toBe(201)
      expect(result.body).toMatchObject({
        session: null,
        title: null,
        kind: 'file',
        name: expect.stringMatching(/^none\/out\//),
      })
      const name = (result.body as { name: string }).name
      expect(statSync(join(root, 'agent', name)).size).toBe(size)
    }
    expect(readdirSync(join(root, 'agent/none/out'))).toHaveLength(2)
  })

  it('refuses oversized files without publishing an event or creating a copy', async () => {
    const source = join(dir, 'large')
    writeFileSync(source, 'x'.repeat(33))
    expect(await show({ path: source })).toMatchObject({
      status: 413,
      body: { error: 'file_too_large', maxBytes: 32 },
    })
    expect(existsSync(join(root, 'agent'))).toBe(false)
    expect(daemon.events.lastSeq).toBe(0)
  })

  it('removes the incomplete copy when the source grows beyond its checked size', async () => {
    const source = join(dir, 'growing')
    writeFileSync(source, 'small')
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open)
      .mockImplementationOnce(open)
      .mockImplementationOnce(async (path, ...args) => {
        // The destination opens after the source's size check, before the copy.
        appendFileSync(source, 'x'.repeat(32))
        return open(path, ...args)
      })
    expect(await show({ path: source })).toMatchObject({
      status: 413,
      body: { error: 'file_too_large', maxBytes: 32 },
    })
    expect(readdirSync(join(root, 'agent/none/out'))).toEqual([])
    expect(daemon.events.lastSeq).toBe(0)
  })

  it('refuses a missing exchange root with an installation error without creating it', async () => {
    rmSync(root, { recursive: true })
    const source = join(dir, 'report')
    writeFileSync(source, 'report')
    expect(await show({ path: source })).toMatchObject({
      status: 503,
      body: {
        error: 'exchange_unavailable',
        detail: expect.stringContaining('must already exist'),
      },
    })
    expect(existsSync(root)).toBe(false)
    expect(daemon.events.lastSeq).toBe(0)
  })

  it('refuses source symlinks, directories, special files and missing files', async () => {
    const source = join(dir, 'report')
    const link = join(dir, 'link')
    const fifo = join(dir, 'fifo')
    writeFileSync(source, 'report')
    symlinkSync(source, link)
    execFileSync('mkfifo', [fifo])
    for (const path of [link, dir, fifo, '/dev/null', join(dir, 'missing')]) {
      expect(await show({ path })).toMatchObject({ status: 400, body: { error: 'invalid_file' } })
    }
    expect(daemon.events.lastSeq).toBe(0)
    expect(existsSync(join(root, 'agent'))).toBe(false)
  })

  it.each([
    'agent',
    'agent/none',
    'agent/none/out',
  ])('refuses a symlink at exchange subdirectory %s', async (part) => {
    const other = join(dir, 'outside')
    mkdirSync(other)
    mkdirSync(join(root, part, '..'), { recursive: true })
    symlinkSync(other, join(root, part))
    const source = join(dir, 'report')
    writeFileSync(source, 'report')
    expect(await show({ path: source })).toMatchObject({
      status: 503,
      body: { error: 'exchange_unavailable' },
    })
    expect(readdirSync(other)).toEqual([])
    expect(daemon.events.lastSeq).toBe(0)
  })

  it.each([
    {},
    { url: 'https://example.com', path: '/tmp/a' },
    { url: null },
    { path: 123 },
    { path: 'relative' },
    { path: '/a\0b' },
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
    { url: 'https://example.com', title: 'a'.repeat(121) },
    { url: 'https://example.com', title: 'line\nbreak' },
    { url: 'https://example.com', title: 'esc\u001b[31m' },
    { url: 'https://example.com', title: 'bidi\u202e' },
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

describe('show configuration', () => {
  it('defaults to the installed exchange and a 25 MiB cap', () => {
    expect(resolveShowConfig({})).toEqual({
      exchangeRoot: '/srv/workspaces/exchange',
      maxBytes: 25 * 1024 * 1024,
    })
  })

  it.each([
    '0',
    '-1',
    '1.5',
    '',
    'abc',
    '9007199254740992',
  ])('rejects invalid size cap %j', (value) => {
    expect(() => resolveShowConfig({ TETHER_SHOW_MAX_BYTES: value })).toThrow(
      /TETHER_SHOW_MAX_BYTES/,
    )
  })

  it('rejects relative exchange roots', () => {
    expect(() => resolveShowConfig({ TETHER_EXCHANGE_ROOT: 'relative' })).toThrow(
      /TETHER_EXCHANGE_ROOT/,
    )
  })
})
