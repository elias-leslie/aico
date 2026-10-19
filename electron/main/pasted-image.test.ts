import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
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
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, 'old')
  utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000)
  return path
}

describe('savePastedImage', () => {
  it('creates the folder and writes a uniquely named private PNG', () => {
    const s = store()
    const a = savePastedImage(s, new Uint8Array([1, 2]), 1000)
    const b = savePastedImage(s, new Uint8Array([1, 2]), 1000)
    expect(a).not.toBe(b)
    expect(a).toMatch(/\/paste-1000-[0-9a-f]{12}\.png$/)
    expect(statSync(a).mode & 0o777).toBe(0o640)
    expect(statSync(s.dir).mode & 0o022).toBe(0)
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
