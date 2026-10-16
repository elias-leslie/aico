// Control-mode link against a real tmux server: a headless xterm fed by the
// link must show what tmux itself holds -- screen and history -- whether it
// attached before the output, in the middle of it, under a full-screen
// program, or after a resize. Skipped where tmux is not installed.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TERMINAL_HISTORY_LINES } from '../shared/terminal-history'
import { ControlTerminal } from './tmux-control'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
})()

// Unix socket paths are short; keep the server under /tmp.
const dir = hasTmux ? mkdtempSync('/tmp/aico-ct-') : ''
const sock = join(dir, 's')
const env = { ...process.env }
delete env.TMUX
const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8', env })
const attachArgv = ['tmux', '-S', sock, 'attach-session', '-t', 't']
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Viewer {
  link: ControlTerminal
  term: Terminal
}

const viewers: Viewer[] = []
function view(cols: number, rows: number): Viewer {
  const term = new Terminal({
    cols,
    rows,
    scrollback: TERMINAL_HISTORY_LINES,
    allowProposedApi: true,
  })
  const link = new ControlTerminal(attachArgv, env, { cols, rows })
  link.onData((data) => term.write(data))
  const viewer = { link, term }
  viewers.push(viewer)
  return viewer
}

async function settle(viewer: Viewer, ms = 500): Promise<void> {
  await sleep(ms)
  await new Promise<void>((resolve) => viewer.term.write('', resolve))
}

const trim = (line: string) => line.replace(/\s+$/, '')
function tmuxScreen(rows: number): string[] {
  return tmux('capture-pane', '-p', '-t', 't').split('\n').slice(0, rows).map(trim)
}
function tmuxHistory(): string[] {
  const size = Number(tmux('display', '-p', '-t', 't', '#{history_size}').trim())
  if (size === 0) return []
  return tmux('capture-pane', '-p', '-t', 't', '-S', '-', '-E', '-1')
    .split('\n')
    .slice(0, size)
    .map(trim)
}
function screenOf({ term }: Viewer): string[] {
  const buffer = term.buffer.active
  const rows: string[] = []
  for (let y = 0; y < term.rows; y += 1)
    rows.push(
      trim(buffer.getLine(buffer.viewportY + y)?.translateToString(true, 0, term.cols) ?? ''),
    )
  return rows
}
function historyOf({ term }: Viewer): string[] {
  const buffer = term.buffer.normal
  const rows: string[] = []
  for (let y = 0; y < buffer.baseY; y += 1)
    rows.push(trim(buffer.getLine(y)?.translateToString(true, 0, term.cols) ?? ''))
  return rows
}

function run(command: string): void {
  tmux('send-keys', '-t', 't', '-l', command)
  tmux('send-keys', '-t', 't', 'Enter')
}

describe.skipIf(!hasTmux)('ControlTerminal against tmux', () => {
  beforeAll(() => {
    writeFileSync(
      join(dir, 'tmux.conf'),
      [
        'set -g history-limit 200000',
        'set -g mouse off',
        'set -g status off',
        'set -g exit-empty off',
      ].join('\n'),
    )
    tmux(
      '-f',
      join(dir, 'tmux.conf'),
      'new-session',
      '-d',
      '-s',
      't',
      '-x',
      '80',
      '-y',
      '24',
      'bash --norc --noprofile',
    )
    tmux('set', '-g', 'history-limit', '200000')
  })

  // One viewer at a time: every attached client takes part in the window size.
  afterEach(async () => {
    for (const { link } of viewers.splice(0)) link.kill()
    await sleep(200)
  })

  afterAll(() => {
    try {
      tmux('kill-server')
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('streams output into native scrollback that matches tmux history', async () => {
    const v = view(80, 24)
    await settle(v)
    v.link.write("PS1='$ '; clear\r")
    await settle(v)
    v.link.write('seq 1 400\r')
    await settle(v, 800)
    expect(screenOf(v)).toEqual(tmuxScreen(24))
    expect(historyOf(v)).toEqual(tmuxHistory())
    expect(historyOf(v)).toContain('1')
  })

  it('attaches in the middle of heavy output without losing or repeating a line', async () => {
    run('for i in $(seq 1 3000); do echo "row $i ✓"; [ $((i % 300)) -eq 0 ] && sleep 0.05; done')
    await sleep(120)
    const late = view(80, 24)
    await sleep(2500)
    await settle(late, 800)
    expect(screenOf(late)).toEqual(tmuxScreen(24))
    const history = historyOf(late)
    expect(history).toEqual(tmuxHistory())
    const rows = history
      .filter((line) => /^row \d+ ✓$/.test(line))
      .map((line) => Number(line.split(' ')[1]))
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]).toBe(rows[i - 1] + 1)
  })

  it('rebuilds a full-screen program: alternate screen, the screen under it, mouse mode', async () => {
    const script = join(dir, 'fullscreen.py')
    writeFileSync(
      script,
      [
        'import sys, time',
        "sys.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[?1h\\x1b[2J\\x1b[H')",
        "for i in range(10): sys.stdout.write(f'FULLSCREEN {i} ❯\\r\\n')",
        "sys.stdout.write('\\x1b[5;7H')",
        'sys.stdout.flush()',
        'try:',
        '    time.sleep(600)',
        'except KeyboardInterrupt:',
        "    sys.stdout.write('\\x1b[?1l\\x1b[?1006l\\x1b[?1000l\\x1b[?1049l')",
        '    sys.stdout.flush()',
      ].join('\n'),
    )
    run(`clear; echo under-the-app; python3 ${script}`)
    await sleep(800)
    const v = view(80, 24)
    await settle(v, 800)
    expect(tmux('display', '-p', '-t', 't', '#{alternate_on}').trim()).toBe('1')
    expect(v.term.buffer.active.type).toBe('alternate')
    expect(screenOf(v)).toEqual(tmuxScreen(24))
    expect(v.term.modes.mouseTrackingMode).toBe('vt200')
    expect(v.term.modes.applicationCursorKeysMode).toBe(true)
    expect(v.term.buffer.active.cursorY).toBe(4)
    expect(v.term.buffer.active.cursorX).toBe(6)
    const normal = v.term.buffer.normal
    const under: string[] = []
    for (let y = 0; y < normal.length; y += 1)
      under.push(trim(normal.getLine(y)?.translateToString(true) ?? ''))
    expect(under).toContain('under-the-app')
    // Leave the program; the shell's screen comes back from xterm's own buffer.
    tmux('send-keys', '-t', 't', 'C-c')
    await settle(v, 600)
    expect(v.term.buffer.active.type).toBe('normal')
    expect(screenOf(v)).toEqual(tmuxScreen(24))
  })

  it('re-reads the pane from tmux after a resize so the two agree', async () => {
    const v = view(80, 24)
    await settle(v)
    run(`clear; printf 'W%.0s' {1..150}; echo; seq 1 30`)
    await settle(v)
    v.term.resize(50, 16)
    v.link.resize(50, 16)
    await settle(v, 1200)
    expect(screenOf(v)).toEqual(tmuxScreen(16))
    expect(historyOf(v)).toEqual(tmuxHistory())
  })

  it('types UTF-8 and pastes through tmux, bracketed only when the program asks', async () => {
    const reader = join(dir, 'reader.py')
    writeFileSync(
      reader,
      [
        'import sys, os, tty',
        "if sys.argv[2] == 'bp': sys.stdout.write('\\x1b[?2004h'); sys.stdout.flush()",
        'tty.setraw(0)',
        "data = b''",
        "while b'Q' not in data: data += os.read(0, 4096)",
        "open(sys.argv[1], 'wb').write(data)",
      ].join('\n'),
    )
    const v = view(50, 16)
    await settle(v)
    const out = join(dir, 'typed.bin')
    run(`python3 ${reader} ${out} bp`)
    await sleep(500)
    v.link.write('é❯ ')
    v.link.paste('one\ntwo')
    v.link.write('Q')
    await sleep(800)
    expect(readFileSync(out, 'utf8')).toBe('é❯ \x1b[200~one\rtwo\x1b[201~Q')
  })

  it('reports exit when the session goes away', async () => {
    const v = view(50, 16)
    await settle(v)
    const exited = new Promise<void>((resolve) => v.link.onExit(resolve))
    tmux('kill-session', '-t', 't')
    await expect(
      Promise.race([exited.then(() => 'exit'), sleep(3000).then(() => 'timeout')]),
    ).resolves.toBe('exit')
  })
})
