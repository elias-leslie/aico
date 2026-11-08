// The setup file every project loads (vitest.no-real-deletes.ts): a test can't reach real data or machines.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('refuses a delete outside a temp folder before it happens', () => {
  expect(() => rmSync('/srv/scratch/not-a-real-entry', { recursive: true, force: true })).toThrow(
    /outside a temp folder/,
  )
})

it('judges a path through a link by its target, and a rename by what it overwrites', () => {
  // Made-up names: if the guard breaks, these only fail on a missing path.
  const dir = mkdtempSync(join(tmpdir(), 'guard-'))
  symlinkSync('/srv/scratch', join(dir, 'link'))
  expect(() => rmdirSync(`${dir}/link/not-a-real-entry/`)).toThrow(/outside a temp/)
  expect(() => rmdirSync(`${dir}/link/../not-a-real-entry`)).toThrow(/outside a temp/)
  expect(() => renameSync(`${dir}/missing`, '/srv/scratch/not-a-real-entry')).toThrow(
    /outside a temp/,
  )
  rmSync(dir, { recursive: true })
})

it('refuses the real ssh, sudo and rm outside temp, but runs a stub in a temp folder', () => {
  expect(() => spawnSync('ssh', ['-V'])).toThrow(/real ssh/)
  expect(() => execFileSync('sudo', ['true'])).toThrow(/real sudo/)
  expect(() => spawnSync('rm', ['-rf', '/srv/scratch/not-a-real-entry'])).toThrow(
    /outside a temp folder/,
  )
  expect(() => spawnSync('pkill', ['-0', 'no-such-process'])).toThrow(/real pkill/)
  expect(() => execFileSync('killall', ['-0', 'no-such-process'])).toThrow(/real killall/)
  expect(() => spawnSync('sh', ['-c', 'pkill -0 no-such-process'])).toThrow(/real pkill/)
  expect(() => execFileSync('cd /tmp && killall -0 no-such-process', { shell: true })).toThrow(
    /real killall/,
  )
  // Backups and snapshots: only asking for the version, so a broken guard hurts nothing.
  for (const tool of ['btrfs', 'restic', 'rclone'])
    expect(() => spawnSync(tool, ['--version'])).toThrow(new RegExp(`real ${tool}`))
  // Read-only on purpose: if this guard ever breaks, the check must not hurt the owner's sessions.
  expect(process.env.TMUX).toBeUndefined()
  expect(() => spawnSync('tmux', ['list-sessions'])).toThrow(/tmux without a socket/)
  const dir = mkdtempSync(join(tmpdir(), 'guard-'))
  writeFileSync(join(dir, 'ssh'), '#!/bin/sh\necho stub\n')
  chmodSync(join(dir, 'ssh'), 0o755)
  const out = execFileSync('ssh', ['x'], { env: { PATH: dir }, encoding: 'utf8' })
  expect(out).toBe('stub\n')
  rmSync(dir, { recursive: true })
})
