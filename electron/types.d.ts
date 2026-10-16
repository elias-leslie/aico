// Shape of the preload bridge, shared by renderer code and the global Window.

import type { AicoTerminalFontSettings } from './shared/font-settings'

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
    /** Control-mode windows paste through tmux (bracketed when the program asks). */
    paste(text: string): void
  }
  terminal: {
    /** This window's terminal transport, fixed until the window reloads. */
    transport(): Promise<'attach' | 'control'>
    /** The transport new windows (and reloads) will use. */
    transportSetting(): Promise<'attach' | 'control'>
    /** Switch every window to the other transport; each reloads and reattaches. */
    toggleTransport(): void
  }
  links: {
    /** Open an http(s) URL in the default browser. */
    open(url: string): void
  }
  clipboard: {
    read(): Promise<string>
    /** True when the clipboard holds an image (e.g. a screenshot). */
    hasImage(): Promise<boolean>
    write(text: string): void
  }
  selection: {
    /** Subscribe to indicated-selection deliveries (drives the capture toast);
     * returns an unsubscribe function. */
    onToast(cb: (sel: { kind: string; snippet: string }) => void): () => void
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
    /** Create a new widget running `tool` (TUI slug) in workspace `projectId`. */
    newWidget(tool: string, projectId: string): void
    /** Enabled TUIs (slug + label + accent + SVG mark), in registry order, for the picker. */
    listTuis(): Promise<{ slug: string; displayName: string; accent: string; icon: string }[]>
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
    /** Fire a desktop grab from a click (aico-grab.sh flags: `-p` `-r` `-t`). */
    grab(args: string[]): void
    /** Retire this widget: close the window AND end its tmux session. */
    endSession(): Promise<void>
    /** Mark or unmark this session as a coordinator (titlebar label, centre tile). */
    toggleCoordinator(): void
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
    setBounds(x: number, y: number, w: number, h: number): void
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
