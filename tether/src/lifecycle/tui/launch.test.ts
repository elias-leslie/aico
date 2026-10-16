import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { paneCommand, parseAgentExitMarker } from './launch'

describe('pane supervisor', () => {
  it('starts the agent at OOM score 100 and gives the fallback shell its exit status and the old score', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-supervisor-'))
    try {
      const shell = join(dir, 'shell')
      writeFileSync(
        shell,
        '#!/bin/sh\necho "exit=$TETHER_AGENT_EXIT adj=$(cat /proc/self/oom_score_adj)"\n',
        { mode: 0o700 },
      )
      const before = readFileSync('/proc/self/oom_score_adj', 'utf8').trim()
      const out = execFileSync(
        '/bin/bash',
        ['-c', paneCommand('cat /proc/self/oom_score_adj; (exit 137)')],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SHELL: shell } },
      )
      // Past the screen-clear the supervisor prints first.
      const lines = out
        .slice(out.lastIndexOf('[2J') + 3)
        .trim()
        .split('\n')
      expect(lines).toEqual(['100', `exit=137 adj=${before}`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still starts the agent when the score cannot be changed', () => {
    const out = execFileSync(
      '/bin/bash',
      [
        '-c',
        paneCommand('echo started; (exit 0)').replace(
          /\/proc\/self\/oom_score_adj/g,
          '/nonexistent/x',
        ),
      ],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SHELL: '/bin/true' } },
    )
    expect(out.slice(out.lastIndexOf('[2J') + 3).trim()).toBe('started')
  })

  describe('exit marker', () => {
    // The supervisor names the file after its own cgroup, as a pane scope.
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n')[0] ?? ''
    const scope = cgroup.slice(cgroup.lastIndexOf('/') + 1)
    const run = (line: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'tether-exits-'))
      try {
        const result = spawnSync('/bin/bash', ['-c', paneCommand(line, dir)], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', SHELL: '/bin/true' },
        })
        const path = join(dir, scope)
        return {
          out: result.stdout.slice(result.stdout.lastIndexOf('[2J') + 3).trim(),
          signal: result.signal,
          marker: existsSync(path) ? readFileSync(path, 'utf8') : null,
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it.runIf(scope !== '')('says started while the agent runs and its exit status after', () => {
      const result = run(`cat "${'$'}tether_mark"; (exit 137)`)
      expect(result.out).toBe('started')
      expect(result.marker).toBe('exit 137\n')
      expect(parseAgentExitMarker(result.marker ?? '')).toEqual({ state: 'exit', status: 137 })
    })

    it.runIf(scope !== '')('keeps started when the supervisor is SIGKILLed with the agent', () => {
      const result = run('kill -KILL $$')
      expect(result.signal).toBe('SIGKILL')
      expect(parseAgentExitMarker(result.marker ?? '')).toEqual({ state: 'started' })
    })

    it.runIf(scope !== '')('records a HUP or TERM once the agent is gone, and exits', () => {
      const hup = run('(kill -HUP $$; echo agent-done)')
      expect(hup.out).toBe('agent-done')
      expect(parseAgentExitMarker(hup.marker ?? '')).toEqual({ state: 'signal', signal: 'HUP' })
      const term = run('(kill -TERM $$; true)')
      expect(parseAgentExitMarker(term.marker ?? '')).toEqual({ state: 'signal', signal: 'TERM' })
    })

    it('writes nothing without a marker directory, and rejects unknown markers', () => {
      expect(paneCommand('true')).not.toContain('tether_mark')
      expect(parseAgentExitMarker('exit')).toBeNull()
      expect(parseAgentExitMarker('signal kill')).toBeNull()
    })
  })
})
