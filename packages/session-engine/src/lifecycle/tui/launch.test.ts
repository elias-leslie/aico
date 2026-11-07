import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { paneCommand, parseAgentExitMarker } from './launch'

/** Runs argv[1] under bash on a fresh pty as its session leader (as tmux
 * does), waits for the agent to write its pid to argv[2], then closes the
 * master and reports whether the agent outlived the hangup. */
const PTY_HANGUP_HARNESS = [
  'import json, os, pty, sys, time',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  "    os.execve('/bin/bash', ['/bin/bash', '-c', sys.argv[1]], {'PATH': '/usr/bin:/bin', 'SHELL': '/bin/true'})",
  'deadline = time.time() + 5',
  'while not os.path.exists(sys.argv[2]) and time.time() < deadline:',
  '    time.sleep(0.02)',
  'time.sleep(0.1)',
  'agent = int(open(sys.argv[2]).read())',
  'os.close(fd)',
  'def alive(p):',
  '    try:',
  "        return open(f'/proc/{p}/stat').read().rsplit(')', 1)[1].split()[0] != 'Z'",
  '    except OSError:',
  '        return False',
  'deadline = time.time() + 3',
  'while alive(agent) and time.time() < deadline:',
  '    time.sleep(0.02)',
  'agent_alive = alive(agent)',
  'if agent_alive:',
  '    os.kill(agent, 9)',
  '_, status = os.waitpid(pid, 0)',
  "print(json.dumps({'agent_alive': agent_alive, 'supervisor_status': os.waitstatus_to_exitcode(status)}))",
].join('\n')

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
    // (the cgroup v2 `0::` line; a v1 controller line may come first).
    const cgroup =
      readFileSync('/proc/self/cgroup', 'utf8')
        .split('\n')
        .find((entry) => entry.startsWith('0::')) ?? ''
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

    it.runIf(scope !== '')(
      'passes a HUP or TERM on to the agent, records it once the agent is gone, and exits',
      () => {
        // The agent signals its supervisor, which must hand the signal back.
        const agent = (signal: string) =>
          `trap 'echo agent-got-${signal}; kill $!; exit 1' ${signal}; sleep 5 >/dev/null & kill -${signal} $$; wait`
        const hup = run(agent('HUP'))
        expect(hup.out).toBe('agent-got-HUP')
        expect(hup.signal).toBeNull()
        expect(parseAgentExitMarker(hup.marker ?? '')).toEqual({ state: 'signal', signal: 'HUP' })
        const term = run(agent('TERM'))
        expect(term.out).toBe('agent-got-TERM')
        expect(parseAgentExitMarker(term.marker ?? '')).toEqual({ state: 'signal', signal: 'TERM' })
      },
    )

    it.runIf(scope !== '')(
      'gives the agent INT and QUIT back while the supervisor ignores them',
      () => {
        const result = run('grep SigIgn /proc/self/status')
        const ignored = BigInt(`0x${result.out.split(/\s+/)[1] ?? '0'}`)
        expect(ignored & 0x6n).toBe(0n)
      },
    )

    // tmux sends no signal when a pane closes (kill-pane, kill-session, a
    // dead server, respawn -k): it closes the pty master, and the kernel
    // hangs up the session leader only. The agent must still end.
    it.runIf(scope !== '' && existsSync('/usr/bin/python3'))(
      'ends the agent when the pane pty hangs up, and records the HUP',
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'tether-hangup-'))
        try {
          const pidFile = join(dir, 'agent.pid')
          const line = `/bin/sh -c 'echo $$ >${pidFile}; exec /bin/sleep 1000'`
          const out = execFileSync(
            '/usr/bin/python3',
            ['-I', '-c', PTY_HANGUP_HARNESS, paneCommand(line, dir), pidFile],
            { encoding: 'utf8', timeout: 15_000 },
          )
          expect(JSON.parse(out)).toEqual({ agent_alive: false, supervisor_status: 129 })
          const marker = readFileSync(join(dir, scope), 'utf8')
          expect(parseAgentExitMarker(marker)).toEqual({ state: 'signal', signal: 'HUP' })
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )

    it('writes nothing without a marker directory, and rejects unknown markers', () => {
      expect(paneCommand('true')).not.toContain('tether_mark')
      expect(parseAgentExitMarker('exit')).toBeNull()
      expect(parseAgentExitMarker('signal kill')).toBeNull()
    })
  })
})
