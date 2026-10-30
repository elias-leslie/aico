// Shape of the preload bridge, shared by renderer code and the global Window.

import type { ChatCallResult, ChatInfo, ChatStreamItem } from './shared/chat/types'
import type { AicoTerminalFontSettings } from './shared/font-settings'

export interface SelectionToast {
  kind: string
  snippet: string
  action?: { kind: 'file'; id: string } | { kind: 'copy'; text: string }
}

export interface CheckInMenu {
  status: 'ready' | 'unsupported' | 'unavailable'
  choices: { label: string; time: string; dueAt: number }[]
  /** `due`: its time has passed and Tether holds it until the session is idle. */
  pending: { id: string; time: string; due: boolean }[]
}

/** An Agent Hub prompt a new session can take as instructions. */
export interface InstructionPrompt {
  slug: string
  name: string
  description: string
}

/** One revision of such a prompt, newest first. `current` holds the prompt's
 * content now; an unusable one can't be sent. */
export interface InstructionRevision {
  id: string
  createdAt: string | null
  reason: string
  current: boolean
  usable: boolean
}

export interface InstructionsChoice {
  prompt: string
  revision: string
}

/** A remote host for a new session, and its link state as the hub sees it. */
export interface HostChoice {
  name: string
  state: 'connected' | 'connecting' | 'offline' | 'powered_off' | 'identity_changed'
}

export type Listing<T> = { status: 'ready'; items: T[] } | { status: 'unavailable'; items: [] }

export interface OpenableSession {
  /** Tether session id (8 lowercase hex). */
  id: string
  /** The app or contract that started it; display only. */
  origin: 'aico' | 'a-term' | 'cli' | 'root'
  label: string
  project: string | null
  tool: string | null
  status: 'running'
  locallyOpen: boolean
}

export type { ChatCallResult, ChatFailure, ChatInfo, ChatStreamItem } from './shared/chat/types'
export interface AicoApi {
  pty: {
    start(size: { cols: number; rows: number }): void
    input(data: string): void
    resize(size: { cols: number; rows: number }): void
    /** Ask tmux to re-send its authoritative grid (manual Refresh). Carries the
     * renderer's live grid size so main can re-pair a drifted pty first. */
    refresh(size: { cols: number; rows: number }): void
    /** Subscribe to PTY output; returns an unsubscribe function. */
    onData(cb: (data: string) => void): () => void
    /** Paste goes through tmux (bracketed when the program asks). */
    paste(text: string): void
    /** Another client holds this session's size (true) or it is back here (false);
     * returns an unsubscribe function. */
    onSizeOther(cb: (other: boolean) => void): () => void
    /** Take the size back: deliberate for the Use here button, else a click in the terminal. */
    claimSize(deliberate?: boolean): void
    /** The host this window's session runs on (null: this computer) and its
     * state: `live`, or why the terminal is covered (`connecting`, `offline`,
     * `powered_off`, `identity_changed`, `disconnected`). */
    onHost(cb: (info: { host: string | null; state: string }) => void): () => void
    /** Try the host again now (the Reconnect button). */
    reconnect(): void
  }
  chat: {
    /** The Agent Hub session this window shows as a chat, or null for a terminal window. */
    info(): Promise<ChatInfo | null>
    /** One request for this window's own chat session (methods: session, queue, send,
     * cancel, models); main answers it through Tether. Never throws. */
    call(method: string, args: Record<string, unknown>): Promise<ChatCallResult>
    /** Follow the running turn from `afterSeq`: items arrive until the turn ends or the
     * returned function closes the stream. */
    openStream(afterSeq: number, onItem: (item: ChatStreamItem) => void): Promise<() => void>
  }
  links: {
    /** Open an http(s) URL in the default browser. */
    open(url: string): void
  }
  clipboard: {
    read(): Promise<string>
    /** Saves a clipboard image (e.g. a screenshot) to a file and returns its
     * path, or '' when the clipboard holds no image. */
    imagePath(): Promise<string>
    write(text: string): void
  }
  selection: {
    /** Subscribe to indicated-selection deliveries (drives the capture toast);
     * returns an unsubscribe function. */
    onToast(cb: (sel: SelectionToast) => void): () => void
    /** Show a pending handoff; main accepts only an id sent to this window. */
    showFile(id: string): void
  }
  context: {
    /** Subscribe to this widget's supplemental-context availability status
     * (pushed by main after launch and on window load); drives the persistent
     * titlebar status badge + warning toast. `applicable` is false for TUIs with
     * no supplemental-context mechanism. This independent probe does not claim
     * what an already-running session received. Returns unsubscribe. */
    onMandate(
      cb: (s: { slug: string; state: string; detail: string; applicable: boolean }) => void,
    ): () => void
  }
  actions: {
    /** Create a new widget running `tool` (TUI slug) in workspace `projectId`,
     * optionally with a chosen Agent Hub prompt revision as instructions. */
    newWidget(
      tool: string,
      projectId: string,
      instructions?: InstructionsChoice,
      host?: string,
    ): void
    /** The remote hosts a new session can run on ("This computer" is implied). */
    hosts(): Promise<Listing<HostChoice>>
    instructionPrompts(): Promise<Listing<InstructionPrompt>>
    instructionRevisions(slug: string): Promise<Listing<InstructionRevision>>
    /** Enabled TUIs (slug + label + accent + SVG mark), in registry order, for the picker. */
    listTuis(): Promise<
      { slug: string; displayName: string; accent: string; icon: string; chat?: boolean }[]
    >
    /** Replace the focused widget's running TUI with `tool` (respawns the pane). */
    loadTui(tool: string): void
    /** Aico workspace catalog for the "Open workspace" picker. */
    listProjects(): Promise<{ id: string; name: string; root: string; current: boolean }[]>
    /** Every running Tether session, whichever app started it. Opening one
     * reuses its live process. */
    listOpenableSessions(): Promise<OpenableSession[]>
    openSession(id: string): Promise<void>
    /** Snapshot ownership, tmux, and resource diagnostics for this session. */
    sessionDiagnostics(): Promise<Record<string, unknown>>
    /** Move the focused widget to workspace `id` (respawns its pane there, same tool). */
    switchProject(id: string): void
    /** Hub view: surface every widget. */
    hub(): void
    /** Harvest the freshest selection-bus capture and deliver it. */
    indicate(): void
    /** Retire this widget: close the window AND end its tmux session. */
    endSession(): Promise<void>
    /** Mark or unmark this session as a coordinator (titlebar label, centre tile). */
    toggleCoordinator(): void
    /** "Check in later": the quick choices and this session's pending check-ins. */
    checkInMenu(): Promise<CheckInMenu>
    /** Set a check-in; resolves to its time (`5:30 PM`), rejects with the owner's wording. */
    checkIn(dueAt: number): Promise<string>
    cancelCheckIn(wakeId: string): Promise<void>
  }
  settings: {
    /** Global pinned-action ids, or null if never set (first run). */
    getPins(): Promise<string[] | null>
    /** Persist the pinned set; main broadcasts the change to every widget. */
    setPins(ids: string[]): void
    /** Subscribe to pin-set changes; returns an unsubscribe function. */
    onPinsChanged(cb: (ids: string[]) => void): () => void
    /** Global terminal font settings, or null if never set. */
    getTerminalFont(): Promise<AicoTerminalFontSettings | null>
    /** Persist terminal font settings; main broadcasts the change to every widget. */
    setTerminalFont(settings: AicoTerminalFontSettings): void
    /** Subscribe to terminal font changes; returns an unsubscribe function. */
    onTerminalFontChanged(cb: (settings: AicoTerminalFontSettings) => void): () => void
  }
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** Set the window's outer bounds (px); used by the custom resize handles. */
    /** Report thinking-state transitions so the tray icon can reflect activity. */
    setThinking(on: boolean): void
    /** Set this widget's title-bar name (empty clears it back to `Widget ${seq}`). */
    setName(name: string): void
    /** Subscribe to titlebar info (widget name + its TUI's SVG mark/accent/label)
     * pushed from main; returns an unsubscribe function. */
    onTitle(
      cb: (info: {
        label: string
        name: string | null
        icon: string
        accent: string
        tuiName: string
        tuiSlug: string
        sessionId: string | null
        coordinator: boolean
        /** `Coordinator` or `↳ <coordinator>`, in the coordinator's colour. */
        chip: { text: string; color: string } | null
        /** The host the session runs on; null on this computer. */
        host: string | null
      }) => void,
    ): () => void
    /** Subscribe to focus/blur; returns an unsubscribe function. */
    onFocusChange(cb: (focused: boolean) => void): () => void
    /** Subscribe to the global cursor position (screen px) for the eyes; returns
     * an unsubscribe function. */
    onCursor(cb: (pt: { x: number; y: number }) => void): () => void
    /** Tell main where the eyes sit (client px) so other windows can look at them. */
    setEyeAnchor(pt: { x: number; y: number }): void
    /** Main asks the eyes to look at another window (screen px). */
    onPeerLook(
      cb: (look: { x: number; y: number; delay: number; hold: number }) => void,
    ): () => void
    /** Whether this session needs the owner, as the window shows it (main attention.ts). */
    onAttention(
      cb: (attention: {
        mode: 'none' | 'blocked' | 'finished'
        stage: 'fresh' | 'rising' | 'urgent'
      }) => void,
    ): () => void
  }
  /** Titlebar arcade (see renderer/arcade). */
  arcade: {
    /** Ask main which of these games this window shows; null if none. */
    assign(keys: string[]): Promise<string | null>
    /** Swap this window's game for another one; null if none. */
    next(keys: string[]): Promise<string | null>
    /** Show this game in this window (turning the games on if they're off);
     * null if it isn't one of `keys`. */
    pick(key: string, keys: string[]): Promise<string | null>
    /** Whether the titlebar games are on (a setting shared by every window). */
    enabled(): Promise<boolean>
    /** Turn the titlebar games off, or back on, in every window. */
    toggle(): void
    /** Turn the titlebar games on in every window; already on, nothing changes. */
    turnOn(): void
    /** Called when the games are turned on or off; returns an unsubscribe function. */
    onEnabled(cb: (on: boolean) => void): () => void
    /** The cursor in window coordinates while it is near the titlebar, then one
     * null when it leaves; returns an unsubscribe function. */
    onCursor(cb: (pt: { x: number; y: number } | null) => void): () => void
  }
}

declare global {
  interface Window {
    aico: AicoApi
  }
}

// Vite handles CSS imports at bundle time; tsc just needs the module to exist.
declare module '*.css'
