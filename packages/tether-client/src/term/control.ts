// Control-mode terminal link: a viewer's terminal reads the pane's own output
// instead of an attached tmux client's redraw of it.
//
// With a plain `tmux attach`, xterm only ever sees tmux repainting its screen
// from inside the alternate screen, so it has no scrollback and no knowledge of
// the program's modes. In control mode (`tmux -C`) tmux streams each pane's raw
// output (%output), so xterm parses exactly what the program wrote: native
// scrollback, native selection, and the program's real mouse/alt-screen state.
//
// On attach (and after a backlog pause or a manual refresh) the link reads the
// pane's state in one atomic tmux command list -- mode flags, history plus
// screen, the saved normal screen under an alternate one, and an escape
// sequence the pane has not finished -- and sends it ahead of the stream as a
// terminal reset plus repaint. Output tmux sends before that command list's
// last %end is already in the captures and is dropped; output after it is
// newer and follows the seed.
//
// Attach is progressive: the visible screen first (small, so a slow phone
// link shows the session at once), then the history the viewer asked for.
// A size change repaints only the visible screen: xterm reflows the history it
// already holds. Under an alternate screen a seed carries no normal history
// (it cannot be seen); the link reads it once the program leaves.
//
// Flow control: tmux pauses a pane for a client that falls PAUSE_AFTER_SECONDS
// behind (`pause-after`), and the link reseeds when it does. A viewer with
// credit (a WebSocket) reports what it has delivered; once `creditBytes` are
// outstanding the link stops reading from tmux, so a slow viewer makes tmux
// fall behind and pause instead of growing this process's memory.

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import {
  type Block,
  buildScreenRepaint,
  buildSeed,
  ControlProtocol,
  controlArgv,
  inputCommands,
  leavesAlternateScreen,
  parseSeedFlags,
  SEED_FLAGS,
  seedHistoryLines,
  tmuxCommandArgv,
} from './protocol'
import { FLEET_BIN, FLEET_SESSION_REFUSED } from './remote'

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
  /** Re-read only the visible screen; the terminal keeps its history. */
  repaint(): void
  /** History lines later seeds carry. */
  setHistoryLines(lines: number): void
  resize(cols: number, rows: number): void
  /** The shared window's size changed under this client (another client held
   * it and this one took it back): read the pane again once typing pauses. */
  settleSize(): void
  /** The shared window's size, whether a claim has pinned it, and the tmux
   * clients attached to the session; null when tmux does not answer. */
  windowState(): Promise<WindowState | null>
  kill(): void
  /** After exit: the host's sshd refused another session on the link (its
   * MaxSessions), so trying again at once cannot help. */
  readonly refusedByHost: boolean
  onData(listener: (data: string) => void): void
  onExit(listener: () => void): void
}

/** The session's one tmux window: its size, whether a viewer's claim set it,
 * and the pids of the clients attached to the session. A claim's
 * `resize-window` pins the window (`window-size manual`); until then tmux
 * sizes it to the latest sized client, so nobody holds it yet. */
export interface WindowState {
  cols: number
  rows: number
  pinned: boolean
  clients: number[]
}

/** How long an exit waits for the child's last stderr (ssh's reason). */
const STDERR_DRAIN_MS = 250
/** The tail of stderr kept for that reason. */
const STDERR_TAIL_BYTES = 2048

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
export type ReseedReason =
  | 'attach'
  | 'history'
  | 'resize'
  | 'pause'
  | 'refresh'
  | 'alt-exit'
  | 'queued'

/**
 * What a read sends: `seed` resets the terminal and writes history and
 * screen; `screen` resets it and writes the screen only (the first step of a
 * progressive attach); `repaint` rewrites the visible screen and keeps the
 * terminal's history (after a size change).
 */
export type ReseedKind = 'seed' | 'screen' | 'repaint'

const KIND_RANK: Record<ReseedKind, number> = { repaint: 0, screen: 1, seed: 2 }

export interface ReseedReport {
  reason: ReseedReason
  kind: ReseedKind
  /** The attach target (`$3`). */
  target: string
  readMs: number
  seedBytes: number
  /** History lines the seed carried (0 for screen and repaint). */
  historyLines: number
  /** History lines tmux holds for the pane (-1 when unreadable). */
  historySize: number
  /** Since the last input, or -1 when there was none. */
  sinceInputMs: number
}

export interface ControlTerminalOptions {
  /** History lines each seed carries (the viewer's scrollback should hold as
   * many); `setHistoryLines` changes it for later seeds. */
  historyLines: number
  /**
   * Text this viewer may have outstanding (emitted, not yet `delivered`)
   * before the link stops reading from tmux. Omitted: the viewer takes data
   * as fast as it comes and never reports delivery.
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
  private reseedQueued: { continuePane: boolean; kind: ReseedKind; reason: ReseedReason } | null =
    null
  private historyLines: number
  /** The last seed left out normal-screen history (an alternate screen was on). */
  private historyHidden = false
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
  private seedKind: ReseedKind = 'seed'
  /** Input waits behind a paste so typed keys cannot overtake it. */
  private inputChain: Promise<void> = this.ready
  private pasteSeq = 0
  private exited = false
  private outstanding = 0
  private stalled = false
  /** windowState() calls waiting on tmux; answered null if the link closes first. */
  private readonly sizeQueries = new Set<(state: WindowState | null) => void>()
  /** Live output from the current stdout read, emitted as one piece. */
  private pendingOutput = ''
  private frameTimer: NodeJS.Timeout | undefined
  private clientPid = -1
  private stderrTail = ''
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
    this.historyLines = Math.max(0, Math.trunc(options.historyLines))
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
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    this.child.stdin.on('error', () => {})
    this.child.on('exit', () => {
      // ssh prints why it failed just before it exits; read that first.
      const stderr = this.child.stderr
      if (stderr.readableEnded || stderr.destroyed) return this.finish()
      const timer = setTimeout(() => this.finish(), STDERR_DRAIN_MS)
      stderr.once('close', () => {
        clearTimeout(timer)
        this.finish()
      })
      stderr.once('end', () => {
        clearTimeout(timer)
        this.finish()
      })
    })
    this.child.on('error', () => this.finish())
    if (size) this.send([`refresh-client -C ${this.cols}x${this.rows}`])
    this.read(false, 'attach', this.historyLines > 0 ? 'screen' : 'seed')
  }

  /** History lines later seeds carry (a viewer that asked for earlier lines). */
  setHistoryLines(lines: number): void {
    this.historyLines = Math.max(0, Math.trunc(lines))
  }

  /** The tmux client's own pid, which size claims name, read with the first
   * seed. Locally that is the child; over ssh the child is ssh and the client
   * runs on the host, so it is -1 until tmux says. */
  get pid(): number {
    if (this.clientPid > 0) return this.clientPid
    return this.attachArgv[0] === FLEET_BIN ? -1 : (this.child.pid ?? -1)
  }

  get refusedByHost(): boolean {
    return (
      this.exited && this.attachArgv[0] === FLEET_BIN && FLEET_SESSION_REFUSED.test(this.stderrTail)
    )
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
        const argv = tmuxCommandArgv(this.attachArgv, ['load-buffer', '-b', name, '-'])
        const load = execFile(argv[0], argv.slice(1), { env: this.env }, (error) => resolve(!error))
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

  /** Once the size settles, take the visible screen from tmux again (the
   * program redrew it at the new size); xterm reflows its own history. */
  settleSize(): void {
    if (this.phase === 'closed') return
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    this.reseedTimer = setTimeout(() => this.reseedAfterTyping(), RESEED_AFTER_RESIZE_MS)
  }

  windowState(): Promise<WindowState | null> {
    if (this.phase === 'closed' || !this.child.stdin.writable) return Promise.resolve(null)
    return new Promise((resolve) => {
      const answer = (state: WindowState | null) => {
        this.sizeQueries.delete(answer)
        resolve(state)
      }
      this.sizeQueries.add(answer)
      const target = this.paneId ? ` -t ${this.paneId}` : ''
      this.sendList(
        [
          `display-message -p${target} '#{window_width} #{window_height} #{window-size}'`,
          `list-clients${target} -F '#{client_pid}'`,
        ],
        ([sizeBlock, clientsBlock]) => {
          const [cols, rows, mode] = (sizeBlock.error ? '' : (sizeBlock.lines[0] ?? ''))
            .trim()
            .split(' ')
          const state = {
            cols: Number(cols),
            rows: Number(rows),
            pinned: mode === 'manual',
            clients: clientsBlock.error
              ? []
              : clientsBlock.lines
                  .map(Number)
                  .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
          }
          const sized =
            Number.isSafeInteger(state.cols) &&
            state.cols > 0 &&
            Number.isSafeInteger(state.rows) &&
            state.rows > 0
          answer(sized ? state : null)
        },
      )
    })
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
    this.read(false, 'resize', 'repaint')
  }

  /** Re-read the pane from tmux and repaint the terminal from it. */
  reseed(continuePane = false, reason: ReseedReason = 'refresh'): void {
    this.read(continuePane, reason, 'seed')
  }

  /** Re-read only the visible screen and rewrite it, keeping the history. */
  repaint(reason: ReseedReason = 'refresh'): void {
    this.read(false, reason, 'repaint')
  }

  private read(continuePane: boolean, reason: ReseedReason, kind: ReseedKind): void {
    if (this.phase === 'closed') return
    if (this.phase === 'seeding') {
      const queued = this.reseedQueued
      const larger = !queued || KIND_RANK[kind] > KIND_RANK[queued.kind]
      this.reseedQueued = {
        continuePane: continuePane || !!queued?.continuePane,
        kind: larger ? kind : (queued?.kind ?? kind),
        reason: larger ? reason : (queued?.reason ?? reason),
      }
      return
    }
    this.phase = 'seeding'
    this.seedStartedAt = Date.now()
    this.seedReason = reason
    this.seedKind = kind
    const fmt = SEED_FLAGS.map((flag) => `#{${flag}}`).join(' ')
    // `-S -0` is the screen's first row: no history.
    const history = kind === 'seed' ? `-S -${this.historyLines} -E -` : ''
    const resume =
      continuePane && this.paneId ? [`refresh-client -A '${this.paneId}:continue'`] : []
    const commands = [
      ...resume,
      `display-message -p '${fmt}'`,
      `capture-pane -p -e ${history}`.trim(),
      kind === 'repaint' ? 'display-message -p ""' : `capture-pane -p -e -q -a ${history}`.trim(),
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
          this.goLive('', 0, -1)
          return
        }
        this.paneId = flags.paneId
        if (flags.client_pid > 0) this.clientPid = flags.client_pid
        const partial = partialBlock.error ? '' : partialBlock.lines.join('')
        if (kind === 'repaint') {
          this.goLive(buildScreenRepaint(flags, mainBlock.lines) + partial, 0, flags.history_size)
          return
        }
        const seed = buildSeed(flags, mainBlock.lines, altBlock.error ? [] : altBlock.lines)
        const carried = seedHistoryLines(flags, mainBlock.lines)
        this.historyHidden = !!flags.alternate_on && flags.history_size > 0
        this.goLive(seed + partial, carried, flags.history_size)
        // The screen is in: the history follows at once, unless tmux holds
        // none to show (or it is hidden under an alternate screen).
        if (kind === 'screen' && flags.history_size > 0 && !flags.alternate_on)
          this.read(false, 'history', 'seed')
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
    this.answerSizeQueries()
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      // already gone
    }
  }

  private goLive(seed: string, historyLines: number, historySize: number): void {
    if (this.phase === 'closed') return
    this.decoder = new TextDecoder('utf-8')
    this.flushOutput(true)
    if (seed) this.emit(seed)
    this.options.onReseed?.({
      reason: this.seedReason,
      kind: this.seedKind,
      target: this.attachArgv.at(-1) ?? '?',
      readMs: Date.now() - this.seedStartedAt,
      seedBytes: seed.length,
      historyLines,
      historySize,
      sinceInputMs: this.lastInputAt ? Date.now() - this.lastInputAt : -1,
    })
    this.phase = 'live'
    this.markReady()
    const queued = this.reseedQueued
    this.reseedQueued = null
    if (queued) this.read(queued.continuePane, queued.reason, queued.kind)
  }

  private output(paneId: string, bytes: Buffer): void {
    // While seeding, these bytes are already in the captures being read.
    if (this.phase === 'live' && paneId === this.paneId) {
      const text = this.decoder.decode(bytes, { stream: true })
      this.pendingOutput += text
      // The program left its alternate screen: the normal history the seed
      // left out can be seen now.
      if (this.historyHidden && leavesAlternateScreen(text)) {
        this.historyHidden = false
        this.reseed(false, 'alt-exit')
      }
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

  private answerSizeQueries(): void {
    for (const answer of [...this.sizeQueries]) answer(null)
  }

  private finish(): void {
    if (this.exited) return
    this.exited = true
    this.flushOutput(true)
    this.phase = 'closed'
    if (this.reseedTimer) clearTimeout(this.reseedTimer)
    this.markReady()
    this.answerSizeQueries()
    for (const listener of this.exitListeners) listener()
  }
}

function spawnPiped(argv: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(argv[0], argv.slice(1), { env, stdio: 'pipe' })
}
