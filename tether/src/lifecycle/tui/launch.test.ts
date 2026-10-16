import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { paneCommand } from './launch'

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
})
