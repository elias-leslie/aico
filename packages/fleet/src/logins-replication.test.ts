import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LoginStore, loginMachine } from './logins'
import { writePrivate } from './secret-files'

const dirs: string[] = []
const owner = { owner: true, role: 'owner', machine: loginMachine() }
const make = (node: string, at = '2026-11-04T20:00:00Z') => {
  const home = mkdtempSync(join(tmpdir(), 'aico-login-sync-'))
  dirs.push(home)
  return new LoginStore({ HOME: home }, () => at, node)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('converges concurrent full-peer writes, keeps deletion tombstones and catches an offline peer up', () => {
  const a = make('alpha'),
    b = make('beta')
  a.set('sample', 'fixture-alpha', {}, owner)
  b.set('sample', 'fixture-beta', {}, owner)
  const sa = a.snapshot(loginMachine(), true),
    sb = b.snapshot(loginMachine(), true)
  a.mergeSnapshot(sb)
  b.mergeSnapshot(sa)
  expect(a.value('sample', owner).toString()).toBe('fixture-beta')
  expect(b.value('sample', owner).toString()).toBe('fixture-beta')
  const stale = b.snapshot(loginMachine(), true)
  a.remove('sample', owner, true)
  b.mergeSnapshot(a.snapshot(loginMachine(), true))
  a.mergeSnapshot(stale)
  expect(a.list()).toEqual([])
  expect(b.list()).toEqual([])
  b.set('offline', 'fixture-offline', {}, owner)
  a.mergeSnapshot(b.snapshot(loginMachine(), true))
  expect(a.value('offline', owner).toString()).toBe('fixture-offline')
})
it('does not let stale worker omissions or assignments roll a newer grant back', () => {
  const oldFull = make('alpha'),
    full = make('beta'),
    worker = make('worker')
  oldFull.assign('hunt-one', ['old-local'], owner)
  const stale = oldFull.snapshot(loginMachine(), false)
  full.assign('hunt-one', ['new-local'], owner)
  full.set('newer', 'fixture-newer', {}, owner)
  worker.mergeSnapshot(full.snapshot(loginMachine(), false))
  worker.mergeSnapshot(stale)
  expect(worker.list().map((e) => e.name)).toEqual(['newer'])
  expect(worker.assignments(owner)['hunt-one']).not.toEqual(['old-local'])
})
it('revokes worker copies by version, so a stale full peer cannot resurrect them', () => {
  const full = make('alpha'),
    worker = make('worker')
  full.set('sample', 'fixture-private-value', {}, owner)
  const stale = full.snapshot(loginMachine(), false)
  worker.mergeSnapshot(stale)
  full.grant('sample', 'machine', loginMachine(), false, owner)
  worker.mergeSnapshot(full.snapshot(loginMachine(), false))
  expect(worker.list()).toEqual([])
  worker.mergeSnapshot(stale)
  expect(worker.list()).toEqual([])
})
it('keeps the release signing key outside Logins and unchanged', () => {
  const store = make('alpha'),
    path = join(store.folder, 'update-signing-key')
  writePrivate(path, 'fixture-system-key')
  expect(() => store.set('update-signing-key', 'fixture-replacement', {}, owner)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('fixture-system-key')
  expect(store.list()).toEqual([])
})
