// Control-mode terminal link: a viewer's terminal reads the pane's own output
// instead of an attached tmux client's redraw of it.
//
// With a plain `tmux attach`, xterm only ever sees tmux repainting its screen
// from inside the alternate screen, so it has no scrollback and no knowledge of
// the program's modes. In control mode (`tmux -C`) tmux streams each pane's raw
// output (%output), so xterm parses exactly what the program wrote: native
// scrollback, native selection, and the program's real mouse/alt-screen state.
//
// On attach (and after a resize, a backlog pause or a manual refresh) the link
// reads the pane's state in one atomic tmux command list -- mode flags,
// history plus screen, the saved normal screen under an alternate one, and an
// escape sequence the pane has not finished -- and sends it ahead of the
// stream as a terminal reset plus repaint. Output tmux sends before that
// command list's last %end is already in the captures and is dropped; output
// after it is newer and follows the seed.
//
// Flow control: tmux pauses a pane for a client that falls PAUSE_AFTER_SECONDS
// behind (`pause-after`), and the link reseeds when it does. A viewer with
// credit (a WebSocket) reports what it has delivered; once `creditBytes` are
// outstanding the link stops reading from tmux, so a slow viewer makes tmux
// fall behind and pause instead of growing this process's memory.

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import {
  type Block,
  buildSeed,
  ControlProtocol,
  controlArgv,
  inputCommands,
  parseSeedFlags,
  SEED_FLAGS,
  socketArgsOf,
} from './protocol'

/** What a viewer uses of its terminal link. */
export interface TerminalLink {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  write(data: string): void
  /** Paste through tmux, bracketed when the program asked for it. */
  paste(text: string): void
  /** Re-read the pane from tmux and repaint the terminal from it. */
  reseed(): void
  resize(cols: number, rows: number): void
  /** The shared window's size changed under this client (another client held
   * it and this one took it back): read the pane again once typing pauses. */
  settleSize(): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: () => void): void
}

/** Wait after the last resize before re-reading the pane from tmux. */
const RESEED_AFTER_RESIZE_MS = 300
/**
 * A resize-driven reseed waits until typing has paused this long, for at most
 * INPUT_HOLD_MAX_MS: a reseed resets the terminal and parses the whole history
 * again, which stalls the view while keystrokes are still being echoed.
 */
const INPUT_QUIET_MS = 400
const INPUT_HOLD_MAX_MS = 3000
/**
 * Output that hides the cursor and has not shown it again is half a frame: a
 * TUI redraw larger than one pty read (4 KiB) reaches tmux in pieces, and a
 * viewer that paints between them shows the cursor jumping back with the line
 * half drawn. Hold such output this long, at most, for the rest of the frame.
 * Claude Code inside tmux gets no synchronized-output (DEC 2026) reply from
 * tmux 3.4, so it brackets its frames only by hiding the cursor.
 */
const FRAME_HOLD_MS = 10
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

type Phase = 'starting' | 'seeding' | 'live' | 'closed'

/** Why the pane was read again; reported with every reseed. */
export type ReseedReason = 'attach' | 'resize' | 'pause' | 'refresh' | 'queued'

export interface ReseedReport {
  reason: ReseedReason
  /** The attach target (`$3`). */
  target: string
  readMs: number
  seedBytes: number
  /** Since the last input, or -1 when there was none. */
  sinceInputMs: number
}

export interface ControlTerminalOptions {
  /** History lines each seed carries (the viewer's scrollback should hold as many). */
  historyLines: number
  /**
   * Text this viewer may have outstanding (emitted, not yet `delivered`)
   * before the link stops reading from tmux. Omitted: the viewer takes data
   * as fast as it comes (the desktop's IPC) and never reports delivery.
   */
  creditBytes?: number
  onReseed?(report: ReseedReport): void
  /** Starts the control client; tests pass a fake. */
  spawn?(argv: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams
}

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
  /** Settles once the first seed is in (or the link closed): input before it
   * has no pane to reach. */
  readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve
  })
  private reseedTimer: NodeJS.Timeout | undefined
  private lastInputAt = 0
  /** When a resize-driven reseed started waiting for typing to pause (0: not waiting). */
  private holdSince = 0
  private seedStartedAt = 0
  private seedReason: ReseedReason = 'attach'
  /** Input waits behind a paste so typed keys cannot overtake it. */
  private inputChain: Promise<void> = this.ready
  private pasteSeq = 0
  private exited = false
  private outstanding = 0
  private stalled = false
  /** Live output from the current stdout read, emitted as one piece. */
  private pendingOutput = ''
  private frameTimer: NodeJS.Timeout | undefined
  cols: number
  rows: number

  /**
   * `size` null starts an unsized client: it sends no size until `resize`, so
   * tmux leaves the shared window's size to the other clients.
   */
  constructor(
    private readonly attachArgv: readonly string[],
    private readonly env: NodeJS.ProcessEnv,
    size: { cols: number; rows: number } | null,
    private readonly options: ControlTerminalOptions,
  ) {
    this.cols = size?.cols ?? 0
    this.rows = size?.rows ?? 0
    const argv = controlArgv(attachArgv)
    this.child = (options.spawn ?? spawnPiped)(argv, env)
    this.protocol = new ControlProtocol({
      output: (paneId, bytes) => this.output(paneId, bytes),
      pause: (paneId) => {
        if (paneId === this.paneId) this.reseed(true, 'pause')
      },
      exit: () => this.kill(),
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.protocol.feed(chunk)
      this.flushOutput(false)
    })
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', () => {})
    this.child.on('exit', () => this.finish())
    this.child.on('error', () => this.finish())
    if (size) this.send([`refresh-client -C ${this.cols}x${this.rows}`])
    this.reseed(false, 'attach')
  }

  get pid(): number {
    return this.child.pid ?? -1
  }

  get closed(): boolean {
    return this.phase === 'closed'
  }

  /** Text emitted and not yet reported delivered (0 without credit). */
  get backlog(): number {
    return this.outstanding
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: () => void): void {
    this.exitListeners.push(listener)
  }

  /** The viewer delivered `length` of the text it was given (credit only):
   * reading from tmux resumes once half the credit is free again. */
  delivered(length: number): void {
    if (this.options.creditBytes === undefined) return
    this.outstanding = Math.max(0, this.outstanding - length)
    if (this.stalled && this.outstanding <= this.options.creditBytes / 2) {
      this.stalled = false
      this.child.stdout.resume()
    }
  }

  write(data: string): void {
    this.lastInputAt = Date.now()
    const bytes = Buffer.from(data, 'utf8')
    this.inputChain = this.inputChain.then(() => {
      if (this.paneId) this.send(inputCommands(this.paneId, bytes))
    })
  }

  /** Paste through tmux, which brackets it when the program asked for that. */
  paste(text: string): void {
    this.lastInputAt = Date.now()
    this.inputChain = this.inputChain.then(async () => {
      if (!this.paneId || this.phase === 'closed') return
      const name = `aico-paste-${this.pid}-${++this.pasteSeq}`
      const loaded = await new Promise<boolean>((resolve) => {
        const load = execFile(
          this.attachArgv[0],
          [...socketArgsOf(this.attachArgv), 'load-buffer', '-b', name, '-'],
          { env: this.env },
          (error) => resolve(!error),
        )
        load.stdin?.on('error', () => {})
        load.stdin?.end(text)
      })
      if (loaded) this.send([`paste-buffer -p -d -b ${name} -t ${this.paneId}`])
    })
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.send([`refresh-client -C ${cols}x${rows}`])
    this.settleSize()
  }

  /** tmux and xterm rewrap old lines differently; once the size settles, take
   * the pane from tmux again so the two agree. */
  settleSize(): void {
    if (this.phase === 'closed') return
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    this.reseedTimer = setTimeout(() => this.reseedAfterTyping(), RESEED_AFTER_RESIZE_MS)
  }

  /** A resize's reseed, held back while the owner is typing. */
  private reseedAfterTyping(): void {
    const now = Date.now()
    if (!this.holdSince) this.holdSince = now
    const quietFor = now - this.lastInputAt
    if (quietFor < INPUT_QUIET_MS && now - this.holdSince < INPUT_HOLD_MAX_MS) {
      this.reseedTimer = setTimeout(() => this.reseedAfterTyping(), INPUT_QUIET_MS - quietFor)
      return
    }
    this.holdSince = 0
    this.reseed(false, 'resize')
  }

  /** Re-read the pane from tmux and repaint the terminal from it. */
  reseed(continuePane = false, reason: ReseedReason = 'refresh'): void {
    if (this.phase === 'closed') return
    if (this.phase === 'seeding') {
      this.reseedQueued = { continuePane: continuePane || !!this.reseedQueued?.continuePane }
      return
    }
    this.phase = 'seeding'
    this.seedStartedAt = Date.now()
    this.seedReason = reason
    const fmt = SEED_FLAGS.map((flag) => `#{${flag}}`).join(' ')
    const history = `-S -${this.options.historyLines}`
    const resume =
      continuePane && this.paneId ? [`refresh-client -A '${this.paneId}:continue'`] : []
    const commands = [
      ...resume,
      `display-message -p '${fmt}'`,
      `capture-pane -p -e ${history} -E -`,
      `capture-pane -p -e -q -a ${history} -E -`,
      // The start of an escape sequence the pane has not finished yet: its
      // end streams after the seed and must not land as text.
      'capture-pane -p -P',
    ]
    // Runs on the list's last %end: output parsed after it is newer than the
    // captures and streams straight after the seed.
    this.sendList(
      commands,
      (blocks) => {
        const [flagsBlock, mainBlock, altBlock, partialBlock] = blocks.slice(resume.length)
        const flags = flagsBlock.error ? null : parseSeedFlags(flagsBlock.lines[0] ?? '')
        if (!flags || mainBlock.error) {
          // Not readable (pane gone): stream from here rather than stall.
          this.goLive('')
          return
        }
        this.paneId = flags.paneId
        const seed = buildSeed(flags, mainBlock.lines, altBlock.error ? [] : altBlock.lines)
        this.goLive(seed + (partialBlock.error ? '' : partialBlock.lines.join('')))
      },
      resume.map((_, i) => i),
    )
  }

  kill(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    if (this.frameTimer) clearTimeout(this.frameTimer)
    this.markReady()
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
    this.flushOutput(true)
    if (seed) this.emit(seed)
    this.options.onReseed?.({
      reason: this.seedReason,
      target: this.attachArgv.at(-1) ?? '?',
      readMs: Date.now() - this.seedStartedAt,
      seedBytes: seed.length,
      sinceInputMs: this.lastInputAt ? Date.now() - this.lastInputAt : -1,
    })
    this.phase = 'live'
    this.markReady()
    const queued = this.reseedQueued
    this.reseedQueued = null
    if (queued) this.reseed(queued.continuePane, 'queued')
  }

  private output(paneId: string, bytes: Buffer): void {
    // While seeding, these bytes are already in the captures being read.
    if (this.phase === 'live' && paneId === this.paneId) {
      this.pendingOutput += this.decoder.decode(bytes, { stream: true })
    }
  }

  /** Emit this read's output in one piece, unless it ends inside a frame. */
  private flushOutput(force: boolean): void {
    const text = this.pendingOutput
    if (!text) return
    if (!force && text.lastIndexOf(HIDE_CURSOR) > text.lastIndexOf(SHOW_CURSOR)) {
      this.frameTimer ??= setTimeout(() => {
        this.frameTimer = undefined
        this.flushOutput(true)
      }, FRAME_HOLD_MS)
      return
    }
    if (this.frameTimer) clearTimeout(this.frameTimer)
    this.frameTimer = undefined
    this.pendingOutput = ''
    if (this.phase !== 'closed') this.emit(text)
  }

  private emit(data: string): void {
    const credit = this.options.creditBytes
    if (credit !== undefined) {
      this.outstanding += data.length
      if (!this.stalled && this.outstanding >= credit) {
        this.stalled = true
        this.child.stdout.pause()
      }
    }
    for (const listener of this.dataListeners) listener(data)
  }

  private send(commands: string[]): void {
    for (const command of commands) this.sendList([command])
  }

  private sendList(
    commands: string[],
    handler?: (blocks: Block[]) => void,
    notifying: readonly number[] = [],
  ): void {
    if (this.phase === 'closed' || !this.child.stdin.writable) return
    this.protocol.expect(commands.length, handler, notifying)
    this.child.stdin.write(`${commands.join(' ; ')}\n`)
  }

  private finish(): void {
    if (this.exited) return
    this.exited = true
    this.flushOutput(true)
    this.phase = 'closed'
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    this.markReady()
    for (const listener of this.exitListeners) listener()
  }
}

function spawnPiped(argv: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(argv[0], argv.slice(1), { env, stdio: 'pipe' })
}
