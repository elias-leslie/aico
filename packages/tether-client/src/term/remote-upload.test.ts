import { spawn as realSpawn, type spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteHost } from './remote'
import { RemoteUploadError, remoteUploadArgv, uploadToHost } from './remote-upload'

const remote: RemoteHost = {
  host: 'agent-work',
  alias: 'agent-work-vm',
  control: '/run/user/1000/tether/peers/agent-work/ssh.ctl',
  stateDir: null,
}

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Stands in for ssh: the words after `--` reach a local sh as one line, as the host's shell would read them. */
function fakeSsh(home: string, seen: string[][] = [], exitCode?: number): typeof spawn {
  return ((bin: string, args: string[], options: object) => {
    seen.push([bin, ...args])
    const line = args.slice(args.indexOf('--') + 1).join(' ')
    const program = exitCode === undefined ? `${line}` : `exit ${exitCode}`
    return realSpawn('/bin/sh', ['-c', program], {
      ...options,
      env: { PATH: process.env.PATH, HOME: home },
    })
  }) as unknown as typeof spawn
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'aico-remote-upload-'))
  homes.push(home)
  return home
}

describe('remoteUploadArgv', () => {
  it('rides the link master only and quotes every word the host reads', () => {
    const argv = remoteUploadArgv(remote, "~/up loads/it's", 'a.png', 12, 90_000)
    expect(argv.slice(0, 2)).toEqual(['/usr/bin/ssh', '-F'])
    expect(argv).toContain('ProxyCommand=false')
    expect(argv.slice(argv.indexOf('-S'), argv.indexOf('--') + 1)).toEqual([
      '-S',
      remote.control,
      'agent-work-vm',
      '--',
    ])
    expect(argv.slice(-5)).toEqual(['sh', `'~/up loads/it'\\''s'`, "'a.png'", '2', '12'])
  })

  it('refuses a name or folder that could leave the folder or the line', () => {
    for (const name of ['../x', 'a/b', '.hidden', 'a b', '']) {
      expect(() => remoteUploadArgv(remote, '~/u', name, 1, 1000)).toThrow()
    }
    for (const dir of ['relative', '', '~/a\nb']) {
      expect(() => remoteUploadArgv(remote, dir, 'a.png', 1, 1000)).toThrow()
    }
  })
})

describe('uploadToHost', () => {
  it('stores the bytes privately under the host home and answers its absolute path', async () => {
    const home = setup()
    const seen: string[][] = []
    const path = await uploadToHost(remote, Buffer.from('hello'), 'one.txt', {
      dir: '~/.cache/aico/uploads',
      maxAgeMs: 3_600_000,
      spawnProcess: fakeSsh(home, seen),
    })
    expect(path).toBe(join(home, '.cache/aico/uploads/one.txt'))
    expect(readFileSync(path, 'utf8')).toBe('hello')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.cache/aico/uploads')).mode & 0o777).toBe(0o700)
    expect(seen).toHaveLength(1)
  })

  it('takes an absolute folder, and removes uploads past the age limit', async () => {
    const home = setup()
    const dir = join(home, 'uploads')
    mkdirSync(dir)
    writeFileSync(join(dir, 'old.txt'), 'x')
    writeFileSync(join(dir, 'new.txt'), 'x')
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(join(dir, 'old.txt'), old, old)
    await uploadToHost(remote, Buffer.from('y'), 'two.txt', {
      dir,
      maxAgeMs: 3_600_000,
      spawnProcess: fakeSsh(home),
    })
    expect(existsSync(join(dir, 'old.txt'))).toBe(false)
    expect(existsSync(join(dir, 'new.txt'))).toBe(true)
    expect(existsSync(join(dir, 'two.txt'))).toBe(true)
  })

  it('never overwrites a file already there', async () => {
    const home = setup()
    const dir = join(home, 'uploads')
    mkdirSync(dir)
    writeFileSync(join(dir, 'same.txt'), 'first')
    await expect(
      uploadToHost(remote, Buffer.from('second'), 'same.txt', {
        dir,
        maxAgeMs: 3_600_000,
        spawnProcess: fakeSsh(home),
      }),
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(readFileSync(join(dir, 'same.txt'), 'utf8')).toBe('first')
  })

  it('says the host is offline when ssh itself fails (255) or cannot start', async () => {
    const home = setup()
    const options = { dir: '~/u', maxAgeMs: 1000 }
    await expect(
      uploadToHost(remote, Buffer.from('a'), 'a.txt', {
        ...options,
        spawnProcess: fakeSsh(home, [], 255),
      }),
    ).rejects.toMatchObject({ kind: 'offline', host: 'agent-work' })
    await expect(
      uploadToHost(remote, Buffer.from('a'), 'a.txt', {
        ...options,
        spawnProcess: (() => realSpawn('/nonexistent/ssh', [])) as unknown as typeof spawn,
      }),
    ).rejects.toBeInstanceOf(RemoteUploadError)
  })

  it('says it failed (not offline) when the host answers but stores nothing', async () => {
    const home = setup()
    await expect(
      uploadToHost(remote, Buffer.from('a'), 'a.txt', {
        dir: '~/u',
        maxAgeMs: 1000,
        spawnProcess: fakeSsh(home, [], 1),
      }),
    ).rejects.toMatchObject({ kind: 'failed' })
  })
})
