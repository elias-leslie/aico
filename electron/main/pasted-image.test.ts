import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { savePastedImage } from './pasted-image'

const DAY = 86_400_000
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store() {
  const root = mkdtempSync(join(tmpdir(), 'aico-pasted-image-'))
  roots.push(root)
  return { dir: join(root, 'nested', 'pasted-images'), maxAgeMs: DAY }
}

function plant(dir: string, name: string, ageMs: number, now: number): string {
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const path = join(dir, name)
  writeFileSync(path, 'old')
  utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000)
  return path
}

describe('savePastedImage', () => {
  it('creates a uniquely named PNG readable by the agent even with a restrictive umask', () => {
    const s = store()
    const mask = process.umask(0o077)
    try {
      const a = savePastedImage(s, new Uint8Array([1, 2]), 1000)
      const b = savePastedImage(s, new Uint8Array([1, 2]), 1000)
      expect(a).not.toBe(b)
      expect(a).toMatch(/\/paste-1000-[0-9a-f]{12}\.png$/)
      expect(statSync(a).mode & 0o777).toBe(0o644)
      expect(statSync(s.dir).mode & 0o777).toBe(0o755)
      expect(statSync(join(s.dir, '..')).mode & 0o777).toBe(0o755)
    } finally {
      process.umask(mask)
    }
  })

  it('refuses a planted store directory link before pruning or writing in its target', () => {
    const s = store()
    const target = join(s.dir, '..', 'target')
    const old = plant(target, 'paste-1-aaaaaaaaaaaa.png', 2 * DAY, Date.now())
    symlinkSync(target, s.dir)
    expect(() => savePastedImage(s, new Uint8Array([9]))).toThrow(/not links/)
    expect(readdirSync(target)).toEqual([old.split('/').at(-1)])
    expect(lstatSync(s.dir).isSymbolicLink()).toBe(true)
  })

  it('refuses a planted parent directory link before creating the store', () => {
    const s = store()
    const target = join(s.dir, '..', '..', 'target')
    mkdirSync(target)
    symlinkSync(target, join(s.dir, '..'))
    expect(() => savePastedImage(s, new Uint8Array([9]))).toThrow(/not links/)
    expect(readdirSync(target)).toEqual([])
  })

  it('refuses writable store and parent directories before pruning or writing', () => {
    for (const unsafe of ['store', 'parent']) {
      const s = store()
      const old = plant(s.dir, 'paste-1-aaaaaaaaaaaa.png', 2 * DAY, Date.now())
      chmodSync(unsafe === 'store' ? s.dir : join(s.dir, '..'), 0o777)
      expect(() => savePastedImage(s, new Uint8Array([9]))).toThrow(/writable only by you/)
      expect(readdirSync(s.dir)).toEqual([old.split('/').at(-1)])
    }
  })

  it('leaves planted file links and directories alone while pruning stale regular pastes', () => {
    const s = store()
    const now = Date.now()
    const target = plant(join(s.dir, '..'), 'target.png', 2 * DAY, now)
    mkdirSync(s.dir, { mode: 0o755 })
    const linked = join(s.dir, 'paste-1-aaaaaaaaaaaa.png')
    const dangling = join(s.dir, 'paste-2-bbbbbbbbbbbb.png')
    const directory = join(s.dir, 'paste-3-cccccccccccc.png')
    symlinkSync(target, linked)
    symlinkSync(join(s.dir, '..', 'missing'), dangling)
    mkdirSync(directory)
    utimesSync(directory, (now - 2 * DAY) / 1000, (now - 2 * DAY) / 1000)
    plant(s.dir, 'paste-4-dddddddddddd.png', 2 * DAY, now)
    const path = savePastedImage(s, new Uint8Array([9]), now)
    expect(
      readdirSync(s.dir)
        .map((name) => join(s.dir, name))
        .sort(),
    ).toEqual([linked, dangling, directory, path].sort())
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(statSync(target).isFile()).toBe(true)
  })

  it('prunes our pastes older than the keep time and nothing else', () => {
    const s = store()
    const now = Date.now()
    const stale = plant(s.dir, 'paste-1-aaaaaaaaaaaa.png', DAY + 60_000, now)
    const fresh = plant(s.dir, 'paste-2-bbbbbbbbbbbb.png', DAY - 60_000, now)
    const foreign = plant(s.dir, 'notes.png', 5 * DAY, now)
    const path = savePastedImage(s, new Uint8Array([9]), now)
    const left = readdirSync(s.dir).map((name) => join(s.dir, name))
    expect(left.sort()).toEqual([fresh, foreign, path].sort())
    expect(left).not.toContain(stale)
  })
})
