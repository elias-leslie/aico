import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = resolve(__dirname, '../../../scripts/standby-address.sh')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function machine(workstationUp: boolean, connectorOn: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'standby-address-'))
  dirs.push(dir)
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  tool('ssh', `exit ${workstationUp ? 0 : 255}`)
  tool('systemctl', `exit ${connectorOn ? 0 : 3}`)
  tool('sudo', `echo "$4" >> ${join(dir, 'changes')}`)
  const run = () =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { PATH: `${dir}:/usr/bin:/bin`, AICO_DATA_DIR: dir, HOME: dir },
    })
  const changes = () =>
    existsSync(join(dir, 'changes')) ? readFileSync(join(dir, 'changes'), 'utf8').trim() : ''
  return { run, changes }
}

it('steps back only after the workstation answered twice in a row', () => {
  const m = machine(true, true)
  expect(m.run().status).toBe(0)
  expect(m.changes()).toBe('')
  m.run()
  expect(m.changes()).toBe('stop')
})

it('comes back at the first check the workstation misses', () => {
  const m = machine(false, false)
  expect(m.run().stdout).toContain('now on')
  expect(m.changes()).toBe('start')
})

it('touches nothing when already right, and exits clean with the workstation off', () => {
  const off = machine(false, true)
  expect(off.run().status).toBe(0)
  expect(off.changes()).toBe('')
  const on = machine(true, false)
  on.run()
  on.run()
  expect(on.changes()).toBe('')
})
