// Control-mode terminal link: the window's terminal reads the pane's own output
// instead of an attached tmux client's redraw of it.
//
// With a plain `tmux attach`, xterm only ever sees tmux repainting its screen
// from inside the alternate screen, so it has no scrollback and no knowledge of
// the program's modes; history had to come from tmux pages shown in an overlay.
// In control mode (`tmux -C`) tmux streams each pane's raw output (%output), so
// xterm parses exactly what the program wrote: native scrollback, native
// selection, and the program's real mouse/alt-screen state.
//
// On attach (and after a resize, a backlog pause or a manual refresh) the link
// reads the pane's state in one atomic tmux command list -- mode flags,
// history plus screen, and the saved normal screen under an alternate one --
// and sends it ahead of the stream as a terminal reset plus repaint. Output
// tmux sends before that command list completes is already in the captures and
// is dropped; output after its last %end is newer and follows the seed.
//
// The link presents the slice of node-pty's IPty that the main process uses, so
// the attach path and this one are interchangeable per window.

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { TERMINAL_HISTORY_LINES } from '../shared/terminal-history'
import { sandboxedTmux } from './tmux-sandbox'

/** The IPty surface Aico's main process relies on. */
export interface TerminalLink {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: () => void): void
}

/** Seconds tmux may fall behind before it pauses the pane (then we reseed). */
const PAUSE_AFTER_SECONDS = 5
/** Wait after the last resize before re-reading the pane from tmux. */
const RESEED_AFTER_RESIZE_MS = 300
/** Bytes per send-keys command; keeps each command line short. */
const INPUT_CHUNK_BYTES = 512

const ESC = '\x1b'

/** Pane state read with every seed, in this order. */
export const SEED_FLAGS = [
  'pane_id',
  'alternate_on',
  'alternate_saved_x',
  'alternate_saved_y',
  'cursor_x',
  'cursor_y',
  'cursor_flag',
  'insert_flag',
  'keypad_cursor_flag',
  'keypad_flag',
  'wrap_flag',
  'origin_flag',
  'mouse_standard_flag',
  'mouse_button_flag',
  'mouse_any_flag',
  'mouse_sgr_flag',
  'scroll_region_upper',
  'scroll_region_lower',
] as const

export type SeedFlags = { paneId: string } & Record<
  Exclude<(typeof SEED_FLAGS)[number], 'pane_id'>,
  number
>

export function parseSeedFlags(line: string): SeedFlags | null {
  const parts = line.trim().split(' ')
  if (parts.length !== SEED_FLAGS.length || !/^%\d+$/.test(parts[0])) return null
  const flags: Record<string, number | string> = { paneId: parts[0] }
  for (let i = 1; i < SEED_FLAGS.length; i += 1) {
    const n = Number(parts[i])
    if (!Number.isInteger(n) || n < 0) return null
    flags[SEED_FLAGS[i]] = n
  }
  return flags as SeedFlags
}

/** Decode a %output value: tmux escapes control bytes and backslash as \ooo. */
export function decodeOutputValue(value: string): Buffer {
  const bytes = Buffer.allocUnsafe(value.length)
  let n = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x5c && i + 3 < value.length && isOctal(value, i + 1)) {
      bytes[n++] = parseInt(value.slice(i + 1, i + 4), 8)
      i += 3
    } else bytes[n++] = code & 0xff
  }
  return bytes.subarray(0, n)
}

function isOctal(value: string, at: number): boolean {
  for (let i = at; i < at + 3; i += 1) {
    const c = value.charCodeAt(i)
    if (!(c >= 0x30 && c <= 0x37)) return false
  }
  return true
}

/**
 * The terminal state for a pane, as one string for xterm: a full reset, the
 * history and screen (with the saved normal screen under an alternate one),
 * then the cursor and the modes tmux reports. Lines arrive as tmux printed
 * them with -e (one row each, colour escapes included).
 */
export function buildSeed(
  flags: SeedFlags,
  screenAndHistory: string[],
  savedNormal: string[],
  rows: number,
): string {
  const lines = (list: string[]) => list.map((line) => `${line}${ESC}[0m`).join('\r\n')
  let seed = `${ESC}c`
  if (flags.alternate_on) {
    const split = Math.max(0, screenAndHistory.length - rows)
    const history = screenAndHistory.slice(0, split)
    const altScreen = screenAndHistory.slice(split)
    const normal = savedNormal.slice(-rows)
    seed += lines([...history, ...normal])
    seed += `${ESC}[${flags.alternate_saved_y + 1};${flags.alternate_saved_x + 1}H`
    seed += `${ESC}[?1049h${ESC}[H`
    seed += lines(altScreen)
  } else {
    seed += lines(screenAndHistory)
  }
  seed += `${ESC}[0m${ESC}[${flags.scroll_region_upper + 1};${flags.scroll_region_lower + 1}r`
  if (flags.origin_flag) seed += `${ESC}[?6h`
  seed += `${ESC}[${flags.cursor_y + 1};${flags.cursor_x + 1}H`
  if (!flags.cursor_flag) seed += `${ESC}[?25l`
  if (!flags.wrap_flag) seed += `${ESC}[?7l`
  if (flags.insert_flag) seed += `${ESC}[4h`
  if (flags.keypad_cursor_flag) seed += `${ESC}[?1h`
  if (flags.keypad_flag) seed += `${ESC}=`
  if (flags.mouse_standard_flag) seed += `${ESC}[?1000h`
  if (flags.mouse_button_flag) seed += `${ESC}[?1002h`
  if (flags.mouse_any_flag && !flags.mouse_standard_flag && !flags.mouse_button_flag)
    seed += `${ESC}[?1003h`
  if (flags.mouse_sgr_flag) seed += `${ESC}[?1006h`
  return seed
}

/** `tmux … attach-session -t X` from Tether, as a control-mode client. */
export function controlArgv(attachArgv: readonly string[]): string[] {
  const at = attachArgv.findIndex((arg) => arg === 'attach-session' || arg === 'attach')
  if (at < 1) throw new Error('attach argv has no attach-session command')
  return [attachArgv[0], '-C', ...attachArgv.slice(1), '-f', `pause-after=${PAUSE_AFTER_SECONDS}`]
}

/** send-keys commands typing `bytes` into `paneId` as hex key codes. */
export function inputCommands(paneId: string, bytes: Buffer): string[] {
  const commands: string[] = []
  for (let at = 0; at < bytes.length; at += INPUT_CHUNK_BYTES) {
    const hex = [...bytes.subarray(at, at + INPUT_CHUNK_BYTES)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    commands.push(`send-keys -t ${paneId} -H ${hex}`)
  }
  return commands
}

type Block = { lines: string[]; error: boolean }
type BlockHandler = ((block: Block) => void) | null

/**
 * Line protocol of a control client: command replies (%begin…%end/%error) and
 * notifications. Every command we send produces one reply block flagged 1; the
 * block tmux opens the session with (flag 0) is not ours.
 */
export class ControlProtocol {
  private buffer: Buffer = Buffer.alloc(0)
  private block: (Block & { ours: boolean }) | null = null
  private readonly handlers: BlockHandler[] = []

  constructor(
    private readonly events: {
      output: (paneId: string, bytes: Buffer) => void
      pause: (paneId: string) => void
      exit: (reason: string) => void
    },
  ) {}

  /** Register reply handlers for a command list of `count` commands. */
  expect(count: number, handler?: (blocks: Block[]) => void): void {
    if (!handler) {
      for (let i = 0; i < count; i += 1) this.handlers.push(null)
      return
    }
    const blocks: Block[] = []
    for (let i = 0; i < count; i += 1) {
      this.handlers.push((block) => {
        blocks.push(block)
        if (blocks.length === count) handler(blocks)
      })
    }
  }

  feed(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    let start = 0
    for (;;) {
      const nl = this.buffer.indexOf(10, start)
      if (nl < 0) break
      this.line(this.buffer.subarray(start, nl))
      start = nl + 1
    }
    this.buffer = start ? this.buffer.subarray(start) : this.buffer
  }

  private line(raw: Buffer): void {
    // Replies are raw UTF-8; %output values are escaped ASCII. Parse the
    // framing as latin1 so bytes map 1:1, then decode each payload properly.
    const text = raw.toString('latin1')
    if (this.block) {
      if (text.startsWith('%end ') || text.startsWith('%error ')) {
        const done = this.block
        this.block = null
        done.error = text.startsWith('%error ')
        // Handlers run here, before the next line is parsed, so a handler
        // can switch how the output that follows its reply is treated.
        if (done.ours) this.handlers.shift()?.(done)
        return
      }
      // tmux can report a pause/continue from inside the reply of the command
      // that caused it; neither is reply text.
      if (/^%(pause|continue) %\d+$/.test(text)) return
      this.block.lines.push(raw.toString('utf8'))
      return
    }
    if (text.startsWith('%begin ')) {
      const flags = text.split(' ')[3]
      this.block = { lines: [], error: false, ours: flags === '1' }
      return
    }
    if (text.startsWith('%output ')) {
      const space = text.indexOf(' ', 8)
      if (space > 0)
        this.events.output(text.slice(8, space), decodeOutputValue(text.slice(space + 1)))
      return
    }
    if (text.startsWith('%extended-output ')) {
      const parts = text.split(' ')
      const colon = text.indexOf(' : ')
      if (colon > 0) this.events.output(parts[1], decodeOutputValue(text.slice(colon + 3)))
      return
    }
    if (text.startsWith('%pause ')) {
      this.events.pause(text.slice(7).trim())
      return
    }
    if (text.startsWith('%exit')) this.events.exit(text.slice(5).trim())
  }
}

type Phase = 'starting' | 'seeding' | 'live' | 'closed'

export class ControlTerminal implements TerminalLink {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly protocol: ControlProtocol
  private readonly dataListeners: ((data: string) => void)[] = []
  private readonly exitListeners: (() => void)[] = []
  private decoder = new TextDecoder('utf-8')
  private phase: Phase = 'starting'
  private paneId: string | null = null
  private reseedQueued: { continuePane: boolean } | null = null
  private markReady: () => void = () => {}
  /** Settles once the first seed is in: input before it has no pane to reach. */
  private readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve
  })
  private reseedTimer: NodeJS.Timeout | undefined
  /** Input waits behind a paste so typed keys cannot overtake it. */
  private inputChain: Promise<void> = this.ready
  private pasteSeq = 0
  private exited = false
  cols: number
  rows: number

  constructor(
    private readonly attachArgv: readonly string[],
    private readonly env: NodeJS.ProcessEnv,
    size: { cols: number; rows: number },
    /** Runs a tmux argv in the sandbox; tests that use their own tmux pass identity. */
    private readonly wrap: (tmuxArgv: string[]) => string[] = sandboxedTmux,
  ) {
    this.cols = size.cols
    this.rows = size.rows
    const argv = this.wrap(controlArgv(attachArgv))
    this.child = spawn(argv[0], argv.slice(1), { env, stdio: 'pipe' })
    this.protocol = new ControlProtocol({
      output: (paneId, bytes) => this.output(paneId, bytes),
      pause: (paneId) => {
        if (paneId === this.paneId) this.reseed(true)
      },
      exit: () => this.kill(),
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.protocol.feed(chunk))
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', () => {})
    this.child.on('exit', () => this.finish())
    this.child.on('error', () => this.finish())
    this.send([`refresh-client -C ${this.cols}x${this.rows}`])
    this.reseed()
  }

  get pid(): number {
    return this.child.pid ?? -1
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: () => void): void {
    this.exitListeners.push(listener)
  }

  write(data: string): void {
    const bytes = Buffer.from(data, 'utf8')
    this.inputChain = this.inputChain.then(() => {
      if (this.paneId) this.send(inputCommands(this.paneId, bytes))
    })
  }

  /** Paste through tmux, which brackets it when the program asked for that. */
  paste(text: string): void {
    this.inputChain = this.inputChain.then(async () => {
      if (!this.paneId || this.phase === 'closed') return
      const name = `aico-paste-${this.pid}-${++this.pasteSeq}`
      const [bin, ...loadArgs] = this.wrap([
        this.attachArgv[0],
        ...socketArgsOf(this.attachArgv),
        'load-buffer',
        '-b',
        name,
        '-',
      ])
      await new Promise<void>((resolve) => {
        const load = execFile(bin, loadArgs, { env: this.env }, () => resolve())
        load.stdin?.end(text)
      })
      this.send([`paste-buffer -p -d -b ${name} -t ${this.paneId}`])
    })
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.send([`refresh-client -C ${cols}x${rows}`])
    // tmux and xterm rewrap old lines differently; once the size settles, take
    // the pane from tmux again so the two agree.
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    this.reseedTimer = setTimeout(() => this.reseed(), RESEED_AFTER_RESIZE_MS)
  }

  /** Re-read the pane from tmux and repaint the terminal from it. */
  reseed(continuePane = false): void {
    if (this.phase === 'closed') return
    if (this.phase === 'seeding') {
      this.reseedQueued = { continuePane: continuePane || !!this.reseedQueued?.continuePane }
      return
    }
    this.phase = 'seeding'
    const fmt = SEED_FLAGS.map((flag) => `#{${flag}}`).join(' ')
    const history = `-S -${TERMINAL_HISTORY_LINES}`
    const commands = [
      ...(continuePane && this.paneId ? [`refresh-client -A '${this.paneId}:continue'`] : []),
      `display-message -p '${fmt}'`,
      `capture-pane -p -e ${history} -E -`,
      `capture-pane -p -e -q -a ${history} -E -`,
    ]
    const seedAt = commands.length - 3
    // Runs on the list's last %end: output parsed after it is newer than the
    // captures and streams straight after the seed.
    this.sendList(commands, (blocks) => {
      const [flagsBlock, mainBlock, altBlock] = blocks.slice(seedAt)
      const flags = flagsBlock.error ? null : parseSeedFlags(flagsBlock.lines[0] ?? '')
      if (!flags || mainBlock.error) {
        // Not readable (pane gone): stream from here rather than stall.
        this.goLive('')
        return
      }
      this.paneId = flags.paneId
      this.goLive(
        buildSeed(flags, mainBlock.lines, altBlock.error ? [] : altBlock.lines, this.rows),
      )
    })
  }

  kill(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      // already gone
    }
  }

  private goLive(seed: string): void {
    if (this.phase === 'closed') return
    this.decoder = new TextDecoder('utf-8')
    if (seed) this.emit(seed)
    this.phase = 'live'
    this.markReady()
    const queued = this.reseedQueued
    this.reseedQueued = null
    if (queued) this.reseed(queued.continuePane)
  }

  private output(paneId: string, bytes: Buffer): void {
    // While seeding, these bytes are already in the captures being read.
    if (this.phase === 'live' && paneId === this.paneId) this.emitBytes(bytes)
  }

  private emitBytes(bytes: Buffer): void {
    const text = this.decoder.decode(bytes, { stream: true })
    if (text) this.emit(text)
  }

  private emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  private send(commands: string[]): void {
    for (const command of commands) this.sendList([command])
  }

  private sendList(commands: string[], handler?: (blocks: Block[]) => void): void {
    if (this.phase === 'closed' || !this.child.stdin.writable) return
    this.protocol.expect(commands.length, handler)
    this.child.stdin.write(`${commands.join(' ; ')}\n`)
  }

  private finish(): void {
    if (this.exited) return
    this.exited = true
    this.phase = 'closed'
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    for (const listener of this.exitListeners) listener()
  }
}

/** The `-S socket` / `-L name` arguments of a tmux argv. */
function socketArgsOf(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length - 1; i += 1) {
    if (argv[i] === '-S' || argv[i] === '-L') out.push(argv[i], argv[i + 1])
  }
  return out
}
