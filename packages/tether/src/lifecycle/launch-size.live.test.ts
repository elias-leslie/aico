// A fresh root prompt rides one `new-session -e` value through a real tmux
// server. The largest prompt the owner accepts must still fit tmux's client
// command limit beside a realistic pane environment, and the session
// environment must not keep it. Skipped where tmux is not installed.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_FRESH_PROMPT_BYTES } from './root-control'
import { newDetachedTargetArgs, PANE_GATE_COMMAND } from './tmux'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
})()

// Unix socket paths are short; keep the server under /tmp.
const dir = hasTmux ? mkdtempSync('/tmp/aico-ls-') : ''
const socket = join(dir, 's')
const env = { ...process.env }
delete env.TMUX
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env })

// Shaped like a live root pane (about 0.9 KiB measured) with headroom.
const paneEnvironment: Record<string, string> = {
  PATH: Array.from({ length: 12 }, (_, i) => `/home/user/.local/share/tool-${i}/bin`).join(':'),
  HOME: '/home/user',
  AICO_OWNER: 'aico',
  AICO_SESSION_ID: 'aico-widget-0123abcd',
  AICO_WIDGET_ID: '0123abcd',
  AICO_TOOL: 'claude-code',
  AICO_PROJECT_ID: 'sample-project-with-a-long-name',
  AICO_TMUX_SERVER_ID: '0123456789abcdef0123456789abcdef',
  ST_SESSION_ID: 'aico-root-01234567-89ab-4cde-8f01-23456789abcd',
  ST_WORK_ROLE: 'implementation',
  ST_WORK_ROLE_SOURCE: 'tether:root:aico-root-01234567-89ab-4cde-8f01-23456789abcd',
  ST_WORK_ROLE_DISPLAY_NAME: 'A fairly long work role display name for the window',
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-0',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  AICO_ROOT_INITIAL_LAUNCH: '1',
  AICO_ROOT_RESUME_SESSION_ID: '',
  AICO_ROOT_MODEL: 'provider/some-model-name',
  AICO_ROOT_REASONING_EFFORT: 'high',
}

describe.skipIf(!hasTmux)('fresh root prompt through real tmux', () => {
  afterAll(() => {
    try {
      tmux('kill-server')
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('launches the largest accepted prompt and keeps it only in the pane', () => {
    // Multi-byte text with a newline and tab, exactly at the byte limit.
    const unit = '界\n\t'
    const prompt = unit.repeat(Math.floor(MAX_FRESH_PROMPT_BYTES / Buffer.byteLength(unit)))
    const padded = prompt + 'x'.repeat(MAX_FRESH_PROMPT_BYTES - Buffer.byteLength(prompt))
    expect(Buffer.byteLength(padded)).toBe(MAX_FRESH_PROMPT_BYTES)
    const environment = { ...paneEnvironment, AICO_ROOT_INITIAL_PROMPT: padded }
    const args = newDetachedTargetArgs(
      { socket, session: 'aico-0123abcd' },
      80,
      24,
      '/dev/null',
      dir,
      environment,
    )
    expect(args).toContain(PANE_GATE_COMMAND)
    execFileSync('tmux', args, { env })

    const pid = tmux('display-message', '-p', '-t', '=aico-0123abcd:', '#{pane_pid}').trim()
    let pane = ''
    for (let i = 0; i < 50 && !pane.includes('AICO_ROOT_INITIAL_PROMPT='); i++) {
      execFileSync('sleep', ['0.05'])
      pane = readFileSync(`/proc/${pid}/environ`, 'utf8')
    }
    expect(pane.split('\0')).toContain(`AICO_ROOT_INITIAL_PROMPT=${padded}`)
    expect(tmux('show-environment', '-t', '=aico-0123abcd')).not.toContain(
      'AICO_ROOT_INITIAL_PROMPT',
    )
  })
})
