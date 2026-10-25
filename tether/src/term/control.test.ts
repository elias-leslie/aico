import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlTerminal, type ControlTerminalOptions } from './control'
import { SEED_FLAGS } from './protocol'

// The link against a scripted tmux: what it sends on stdin, and what it makes
// of the replies and output fed back on stdout.

const ESC = '\x1b'
const attachArgv = ['/usr/bin/tmux', '-S', '/s.sock', 'attach-session', '-t', '$1']

function fakeTmux() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: 777, kill: vi.fn() })
  const sent: string[] = []
  stdin.on('data', (chunk: Buffer) => sent.push(...chunk.toString().split('\n').filter(Boolean)))
  let number = 100
  return {
    child,
    sent,
    /** One reply block per command, as tmux numbers them. */
    reply(...blocks: (string[] | { error: string[] })[]) {
      let text = ''
      for (const block of blocks) {
        number += 1
        const header = `1700 ${number} 1`
        const lines = Array.isArray(block) ? block : block.error
        text += `%begin ${header}\n${lines.map((l) => `${l}\n`).join('')}`
        text += `${Array.isArray(block) ? '%end' : '%error'} ${header}\n`
      }
      stdout.write(text)
    },
    output(pane: string, value: string) {
      stdout.write(`%output ${pane} ${value}\n`)
    },
    stdout,
  }
}

function flagsLine(overrides: Record<string, number> = {}): string {
  return SEED_FLAGS.map((name) =>
    name === 'pane_id' ? '%5' : String(overrides[name] ?? (name === 'pane_height' ? 24 : 0)),
  ).join(' ')
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const links: ControlTerminal[] = []
function link(
  size: { cols: number; rows: number } | null = { cols: 80, rows: 24 },
  options: Partial<ControlTerminalOptions> = {},
) {
  const tmux = fakeTmux()
  const data: string[] = []
  const term = new ControlTerminal(attachArgv, {}, size, {
    historyLines: 100,
    spawn: () => tmux.child,
    ...options,
  })
  term.onData((text) => data.push(text))
  links.push(term)
  return { term, tmux, data }
}

afterEach(() => {
  for (const term of links.splice(0)) term.kill()
})

describe('ControlTerminal seed', () => {
  it('sizes the client, then reads flags, both captures and the unfinished escape at once', async () => {
    const { tmux } = link()
    await flush()
    expect(tmux.sent).toEqual([
      'refresh-client -C 80x24',
      expect.stringMatching(
        /^display-message -p '#\{pane_id\} #\{pane_height\} .*' ; capture-pane -p -e -S -100 -E - ; capture-pane -p -e -q -a -S -100 -E - ; capture-pane -p -P$/,
      ),
    ])
  })

  it('an unsized client sends no size until it is given one', async () => {
    const { term, tmux } = link(null)
    await flush()
    expect(tmux.sent.some((line) => line.startsWith('refresh-client -C'))).toBe(false)
    expect([term.cols, term.rows]).toEqual([0, 0])
    term.resize(60, 20)
    await flush()
    expect(tmux.sent).toContain('refresh-client -C 60x20')
  })

  it('sends the seed, then the unfinished escape, then only output after the last %end', async () => {
    const reseeds: string[] = []
    const { tmux, data } = link({ cols: 80, rows: 24 }, { onReseed: (r) => reseeds.push(r.reason) })
    tmux.reply([])
    tmux.output('%5', 'before')
    // A history line that reads like another reply's %end is pane text.
    tmux.reply([flagsLine()], ['$ ls', '%end 1700 1 1'], [], [`${ESC}[3`])
    tmux.output('%5', '1mafter')
    tmux.output('%9', 'other pane')
    await flush()
    const [seed, after] = data
    expect(seed.startsWith(`${ESC}c$ ls${ESC}[0m\r\n%end 1700 1 1${ESC}[0m`)).toBe(true)
    expect(seed.endsWith(`${ESC}[1;1H${ESC}[?25l${ESC}[?7l${ESC}[3`)).toBe(true)
    expect(after).toBe('1mafter')
    expect(data).toHaveLength(2)
    expect(reseeds).toEqual(['attach'])
  })

  it('streams without a seed when the pane cannot be read', async () => {
    const { tmux, data } = link()
    tmux.reply([], { error: ['no pane'] }, { error: [] }, [], [])
    tmux.output('%5', 'x')
    await flush()
    expect(data).toEqual([])
    await expect(links[0].ready).resolves.toBeUndefined()
  })

  it('reseeds after a pause and asks tmux to continue the pane first', async () => {
    const { tmux } = link()
    tmux.reply([], [flagsLine()], [], [], [])
    await flush()
    tmux.stdout.write('%pause %5\n')
    await flush()
    expect(tmux.sent.at(-1)).toMatch(/^refresh-client -A '%5:continue' ; display-message/)
  })
})

describe('ControlTerminal frames', () => {
  it('emits one stdout read as one piece', async () => {
    const { tmux, data } = link()
    tmux.reply([], [flagsLine()], [], [], [])
    await flush()
    data.length = 0
    tmux.stdout.write('%output %5 one\n%output %5 two\n')
    await flush()
    expect(data).toEqual(['onetwo'])
  })

  it('holds a redraw split across reads until the cursor is shown again', async () => {
    vi.useFakeTimers()
    try {
      const { tmux, data } = link()
      tmux.reply([], [flagsLine()], [], [], [])
      await vi.advanceTimersByTimeAsync(0)
      data.length = 0
      // Claude Code's busy redraw, cut where the pty read ended (\033 is ESC).
      tmux.output('%5', '\\033[?25l\\033[H\\033[58Bhalf')
      await vi.advanceTimersByTimeAsync(0)
      expect(data).toEqual([])
      tmux.output('%5', ' drawn\\033[65;9H\\033[?25h')
      await vi.advanceTimersByTimeAsync(0)
      expect(data).toEqual([`${ESC}[?25l${ESC}[H${ESC}[58Bhalf drawn${ESC}[65;9H${ESC}[?25h`])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a frame that never shows the cursor again still arrives after a moment', async () => {
    vi.useFakeTimers()
    try {
      const { tmux, data } = link()
      tmux.reply([], [flagsLine()], [], [], [])
      await vi.advanceTimersByTimeAsync(0)
      data.length = 0
      tmux.output('%5', '\\033[?25lspinner')
      await vi.advanceTimersByTimeAsync(5)
      expect(data).toEqual([])
      await vi.advanceTimersByTimeAsync(10)
      expect(data).toEqual([`${ESC}[?25lspinner`])
      // Hidden from earlier, no new hide: nothing to wait for.
      tmux.output('%5', 'more')
      await vi.advanceTimersByTimeAsync(0)
      expect(data.at(-1)).toBe('more')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ControlTerminal input', () => {
  it('types into the pane only once the first seed named it', async () => {
    const { term, tmux } = link()
    term.write('ab')
    await flush()
    expect(tmux.sent.some((line) => line.startsWith('send-keys'))).toBe(false)
    tmux.reply([], [flagsLine()], [], [], [])
    await flush()
    await flush()
    expect(tmux.sent.at(-1)).toBe('send-keys -t %5 -H 61 62')
  })
})

describe('ControlTerminal credit', () => {
  it('stops reading from tmux once the credit is spent and resumes at half', async () => {
    const { term, tmux, data } = link({ cols: 80, rows: 24 }, { creditBytes: 10 })
    tmux.reply([], [flagsLine({ cursor_flag: 1, wrap_flag: 1 })], [], [], [])
    await flush()
    const seedLength = data[0].length
    expect(seedLength).toBeGreaterThan(10)
    expect(tmux.stdout.isPaused()).toBe(true)
    tmux.output('%5', 'held')
    await flush()
    expect(data).toHaveLength(1)
    expect(term.backlog).toBe(seedLength)
    term.delivered(seedLength - 6)
    expect(tmux.stdout.isPaused()).toBe(true)
    term.delivered(1)
    expect(tmux.stdout.isPaused()).toBe(false)
    await flush()
    expect(data.at(-1)).toBe('held')
    expect(term.backlog).toBe(5 + 4)
  })

  it('a viewer without credit is never paced', async () => {
    const { term, tmux, data } = link()
    tmux.reply([], [flagsLine()], [], [], [])
    tmux.output('%5', 'x'.repeat(5000))
    await flush()
    expect(data).toHaveLength(2)
    expect(tmux.stdout.isPaused()).toBe(false)
    expect(term.backlog).toBe(0)
  })
})
