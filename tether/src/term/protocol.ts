// tmux control-mode wire format (`tmux -C`): command replies, pane output,
// and the pane state a seed is built from. Pure functions and the line parser;
// the client that runs tmux is control.ts.

import { SSH_BIN, shellQuote, tmuxIndex } from './remote'

/** Seconds tmux may fall behind before it pauses the pane (then the client reseeds). */
export const PAUSE_AFTER_SECONDS = 5
/** Bytes per send-keys command; keeps each command line short. */
const INPUT_CHUNK_BYTES = 512

const ESC = '\x1b'

/** Pane state read with every seed, in this order. `pane_height` sizes the
 * screen part of the capture, so a client that does not size the window (and
 * so does not know its rows) seeds the same as one that does. */
export const SEED_FLAGS = [
  'pane_id',
  'pane_height',
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
  // Not pane state: the reading client's own pid (the remote one over ssh).
  'client_pid',
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
    if (!/^\d+$/.test(parts[i])) return null
    flags[SEED_FLAGS[i]] = Number(parts[i])
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
): string {
  const lines = (list: string[]) => list.map((line) => `${line}${ESC}[0m`).join('\r\n')
  const rows = flags.pane_height
  let seed = `${ESC}c`
  if (flags.alternate_on) {
    const split = Math.max(0, screenAndHistory.length - rows)
    const history = screenAndHistory.slice(0, split)
    const altScreen = screenAndHistory.slice(split)
    const normal = rows ? savedNormal.slice(-rows) : []
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

/** `tmux … attach-session -t X` from Tether, as a control-mode client. On a
 * remote host the argv is ssh's and tmux follows its `--`: `-C` goes after
 * tmux, never after ssh (where it would ask for compression). */
export function controlArgv(attachArgv: readonly string[]): string[] {
  const tmuxAt = tmuxIndex(attachArgv)
  const at = attachArgv.findIndex((arg) => arg === 'attach-session' || arg === 'attach')
  if (at <= tmuxAt) throw new Error('attach argv has no attach-session command')
  return [
    ...attachArgv.slice(0, tmuxAt + 1),
    '-C',
    ...attachArgv.slice(tmuxAt + 1),
    '-f',
    `pause-after=${PAUSE_AFTER_SECONDS}`,
  ]
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

/** The `-S socket` / `-L name` arguments of a tmux argv (local or over ssh). */
export function socketArgsOf(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = tmuxIndex(argv) + 1; i < argv.length - 1; i += 1) {
    if (argv[i] === '-S' || argv[i] === '-L') out.push(argv[i], argv[i + 1])
  }
  return out
}

/** A one-shot tmux command (`args`) on the attach argv's server, through the
 * same ssh prefix when it is remote. */
export function tmuxCommandArgv(attachArgv: readonly string[], args: readonly string[]): string[] {
  const tmuxAt = tmuxIndex(attachArgv)
  const remote = attachArgv[0] === SSH_BIN
  return [
    ...attachArgv.slice(0, tmuxAt + 1),
    ...(remote ? ['-u'] : []),
    ...socketArgsOf(attachArgv),
    ...(remote ? args.map(shellQuote) : args),
  ]
}

export type Block = { lines: string[]; error: boolean }
type Expected = { handle: ((block: Block) => void) | null; notifies: boolean }

const PAUSE_OR_CONTINUE = /^%(pause|continue) %\d+$/

/**
 * Line protocol of a control client: command replies (%begin…%end/%error) and
 * notifications. Every command we send produces one reply block flagged 1; the
 * block tmux opens the session with (flag 0) is not ours. Reply lines are raw
 * pane text and can look like `%end …`, so a block closes only on the
 * `%end`/`%error` that repeats its own `%begin` header (time, number, flags).
 */
export class ControlProtocol {
  private buffer: Buffer = Buffer.alloc(0)
  private block: (Block & { tail: string; ours: boolean; notifies: boolean }) | null = null
  private readonly expected: Expected[] = []

  constructor(
    private readonly events: {
      output: (paneId: string, bytes: Buffer) => void
      pause: (paneId: string) => void
      exit: (reason: string) => void
    },
  ) {}

  /**
   * Register reply handlers for a command list of `count` commands.
   * `notifying` lists the commands (by index) whose reply tmux can interleave
   * a pane's %pause/%continue into (`refresh-client -A`); in any other reply
   * the same text is pane content.
   */
  expect(
    count: number,
    handler?: (blocks: Block[]) => void,
    notifying: readonly number[] = [],
  ): void {
    const blocks: Block[] = []
    for (let i = 0; i < count; i += 1) {
      this.expected.push({
        handle: handler
          ? (block) => {
              blocks.push(block)
              if (blocks.length === count) handler(blocks)
            }
          : null,
        notifies: notifying.includes(i),
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
      const closes = text.startsWith('%end ') || text.startsWith('%error ')
      if (closes && text.slice(text.indexOf(' ') + 1) === this.block.tail) {
        const done = this.block
        this.block = null
        // Handlers run here, before the next line is parsed, so a handler
        // can switch how the output that follows its reply is treated.
        if (done.ours && this.expected.length)
          this.expected.shift()?.handle?.({
            lines: done.lines,
            error: text.startsWith('%error '),
          })
        return
      }
      // tmux can report a pause/continue from inside the reply of the command
      // that caused it; neither is reply text.
      if (this.block.notifies && PAUSE_OR_CONTINUE.test(text)) return
      this.block.lines.push(raw.toString('utf8'))
      return
    }
    if (text.startsWith('%begin ')) {
      const ours = text.split(' ')[3] === '1'
      this.block = {
        lines: [],
        error: false,
        tail: text.slice(7),
        ours,
        notifies: ours && !!this.expected[0]?.notifies,
      }
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
