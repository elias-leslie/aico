// The real tmux on a throwaway server in a temp folder, started with the production config. Every call
// names that socket and drops $TMUX, so a failure here can only hit the throwaway server.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { lowerTmuxServerOomScore, TMUX_SERVER_OOM_SCORE_ADJ } from './ownership'
import {
  PANE_GATE_COMMAND,
  PANE_OOM_SCORE_ADJ,
  tmuxConf,
  tmuxProfileTargetArgs,
  tmuxServerPidTargetArgs,
} from './tmux'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasTmux)('a Tether tmux server', () => {
  const dir = hasTmux ? realpathSync(mkdtempSync('/tmp/aico-tp-')) : ''
  const sock = join(dir, 's')
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  const tmux = (...args: string[]) =>
    execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8', env }).trim()
  const serverPid = () => Number(tmux('display-message', '-p', '#{pid}'))
  let pid = 0

  beforeAll(() => {
    writeFileSync(join(dir, 'conf'), tmuxConf())
    tmux('-f', join(dir, 'conf'), 'new-session', '-d', '-s', 't', PANE_GATE_COMMAND)
    pid = serverPid()
  })

  afterAll(() => {
    // The profile refuses kill-server, so this server ends the way real ones do.
    try {
      tmux('kill-session', '-t', 't')
    } catch {
      /* already gone */
    }
    try {
      tmux('kill-session', '-t', 'u')
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['kill-server', 'kill-serve', 'kill-serv', 'kill-ser'])('survives %s', (spelling) => {
    expect(tmux(spelling)).toContain('kill-server is off')
    expect(serverPid()).toBe(pid)
  })

  it('survives kill-server from a config file', () => {
    writeFileSync(join(dir, 'source'), 'kill-server\n')
    expect(tmux('source-file', join(dir, 'source'))).toContain('kill-server is off')
    expect(serverPid()).toBe(pid)
  })

  it('protects a server already running, started without the config', () => {
    const other = join(dir, 'running')
    const run = (args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', env }).trim()
    run([
      '-S',
      other,
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      'r',
      '/bin/bash --noprofile --norc',
    ])
    try {
      const before = Number(run(tmuxServerPidTargetArgs(other)))
      expect(readFileSync(`/proc/${before}/oom_score_adj`, 'utf8').trim()).not.toBe('-999')
      run(tmuxProfileTargetArgs(other))
      expect(run(['-S', other, 'kill-server'])).toContain('kill-server is off')
      expect(Number(run(tmuxServerPidTargetArgs(other)))).toBe(before)
      // Only ever lowers: a value above the current one changes nothing.
      const current = Number(readFileSync(`/proc/${before}/oom_score_adj`, 'utf8'))
      lowerTmuxServerOomScore(before, current + 1)
      expect(Number(readFileSync(`/proc/${before}/oom_score_adj`, 'utf8'))).toBe(current)
      lowerTmuxServerOomScore(before, 150)
      expect(Number(readFileSync(`/proc/${before}/oom_score_adj`, 'utf8'))).toBe(
        Math.min(current, 150),
      )
    } finally {
      run(['-S', other, 'kill-session', '-t', 'r'])
    }
  })

  it('keeps panes the kernel can kill while the server is the last choice', async () => {
    const adj = (p: number) => Number(readFileSync(`/proc/${p}/oom_score_adj`, 'utf8'))
    const panePid = () => Number(tmux('list-panes', '-t', 'u', '-F', '#{pane_pid}').split('\n')[0])
    try {
      writeFileSync(`/proc/${pid}/oom_score_adj`, String(TMUX_SERVER_OOM_SCORE_ADJ))
    } catch {
      /* this run's manager cannot go that low; the pane must still reach its value */
    }
    tmux('new-session', '-d', '-s', 'u', PANE_GATE_COMMAND)
    // The gate shell runs a moment after the fork; it has run once it has become the no-RC bash.
    await vi.waitFor(() =>
      expect(readFileSync(`/proc/${panePid()}/cmdline`, 'utf8').split('\0')).toEqual([
        '/bin/bash',
        '--noprofile',
        '--norc',
        '',
      ]),
    )
    expect(adj(panePid())).toBeGreaterThanOrEqual(PANE_OOM_SCORE_ADJ)
  })
})
