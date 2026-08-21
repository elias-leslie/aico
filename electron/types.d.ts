// Shape of the preload bridge, shared by renderer code and the global Window.

import type { AicoTerminalFontSettings } from './shared/font-settings'

export interface ScrollbackPage {
  fromLine: number
  totalLines: number
  text: string
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
  }
  clipboard: {
    read(): Promise<string>
    write(text: string): void
  }
  scrollback: {
    /** Full tmux history (with color escapes) for the read-only overlay. */
    capture(): Promise<string>
    /** Bounded tmux history page (with color escapes), newest tail by default. */
    page(request?: { fromLine?: number; count?: number }): Promise<ScrollbackPage>
    /** Who owns the pane's scrollback, straight from tmux. */
    paneMode(): Promise<{ alternateScreen: boolean; mouseReporting: boolean }>
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
  voice: {
    /** Optional local voice websocket URL (resolved by main from env/default). */
    wsUrl(): Promise<string>
    /** Subscribe to push-to-talk toggles from the global hotkey; returns an unsubscribe function. */
    onToggle(cb: () => void): () => void
  }
  actions: {
    /** Create a new widget running `tool` (TUI slug) in workspace `projectId`. */
    newWidget(tool: string, projectId: string): void
    /** Enabled TUIs (slug + label + accent), in registry order, for the picker. */
    listTuis(): Promise<{ slug: string; displayName: string; accent: string }[]>
    /** Replace the focused widget's running TUI with `tool` (respawns the pane). */
    loadTui(tool: string): void
    /** Aico workspace catalog for the "Open workspace" picker. */
    listProjects(): Promise<{ id: string; name: string; root: string; current: boolean }[]>
    /** Externally-owned tmux sessions Aico can attach without taking ownership. */
    listTmuxSessions(): Promise<{ id: string; label: string; source: string }[]>
    /** Attach an externally-owned tmux session as a widget. */
    attachTmuxSession(id: string): void
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
    retire(): void
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
      }) => void,
    ): () => void
    /** Subscribe to focus/blur; returns an unsubscribe function. */
    onFocusChange(cb: (focused: boolean) => void): () => void
    /** Subscribe to the global cursor position (screen px) for the eyes; returns
     * an unsubscribe function. */
    onCursor(cb: (pt: { x: number; y: number }) => void): () => void
  }
}

declare global {
  interface Window {
    aico: AicoApi
  }
}

// Vite handles CSS imports at bundle time; tsc just needs the module to exist.
declare module '*.css'
