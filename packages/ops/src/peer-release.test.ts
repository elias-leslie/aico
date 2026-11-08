import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = new URL('../../../scripts/peer-release.sh', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The job against a stand-in ssh that always exits `sshExit`. */
function run(sshExit: number) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-release-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  const releases = join(dir, 'releases')
  mkdirSync(bin)
  mkdirSync(releases)
  writeFileSync(join(releases, '.accepted'), `${'a'.repeat(40)}\n`)
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexit ${sshExit}\n`)
  chmodSync(join(bin, 'ssh'), 0o755)
  return spawnSync('bash', [script, 'peer-host', 'peer'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AICO_RELEASES_DIR: releases },
  })
}

it('a peer that does not answer is left for the next run, not a failed job', () => {
  const result = run(255)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("peer isn't answering; the next run sends its release.")
})

it('a peer that answers with an error still fails the job', () => {
  expect(run(1).status).toBe(1)
})
