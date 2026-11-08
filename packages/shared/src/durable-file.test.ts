import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileDurable } from './durable-file'

const calls = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const kinds = new Map<number, string>()
  const mocked = {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      kinds.set(fd, fs.statSync(args[0]).isDirectory() ? 'dir' : 'file')
      return fd
    },
    fsyncSync: (fd: number) => {
      calls.push(`fsync ${kinds.get(fd)}`)
      fs.fsyncSync(fd)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      calls.push('rename')
      if (String(args[1]).endsWith('refused')) throw new Error('no room')
      fs.renameSync(...args)
    },
  }
  return { ...mocked, default: mocked }
})

describe('writeFileDurable', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('syncs the file before the rename and the folder after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-'))
    const path = join(dir, 'phones.json')
    writeFileSync(path, 'old')
    writeFileDurable(path, 'new', { mode: 0o600 })
    expect(calls).toEqual(['fsync file', 'rename', 'fsync dir'])
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['phones.json'])
  })

  it('keeps the mode it was given, and leaves the old file and no temp when it fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-'))
    const secret = join(dir, 'secret')
    writeFileDurable(secret, 'x', { mode: 0o600 })
    expect(statSync(secret).mode & 0o777).toBe(0o600)
    const refused = join(dir, 'refused')
    writeFileSync(refused, 'old')
    expect(() => writeFileDurable(refused, 'new')).toThrow('no room')
    expect(readFileSync(refused, 'utf8')).toBe('old')
    expect(readdirSync(dir).sort()).toEqual(['refused', 'secret'])
  })
})

/** The writers a cut must not leave empty; each goes through writeFileDurable, not its own temp and rename. */
describe('files that must survive a power cut', () => {
  const root = join(import.meta.dirname, '../..')
  const source = (file: string) => {
    const real = vi.importActual<typeof import('node:fs')>('node:fs')
    return real.then((fs) => fs.readFileSync(join(root, file), 'utf8'))
  }
  it.each([
    'web-server/src/app-phones.ts',
    'ops/src/context-sync.ts',
    'ops/src/snapshots.ts',
    'ops/src/backup-runtime.ts',
    'ops/src/backup-retention.ts',
    'ops/src/deploy.ts',
    'fleet/src/trust.ts',
    'session-engine/src/continuity.ts',
    'tether/src/projects.ts',
  ])('%s', async (file) => {
    const text = await source(file)
    expect(text).toContain('writeFileDurable')
    expect(text).not.toMatch(/writeFileSync\(\s*(`[^`]*\.tmp`|tmp|temp|temporary)\b/)
  })
})
