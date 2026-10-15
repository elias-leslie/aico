import { contextBridge, ipcRenderer } from 'electron'
import type { OpenableSession } from '../types'

// Minimal, explicit bridge — no nodeIntegration in the renderer. The renderer
// talks to the tmux-backed PTY only through these channels.
contextBridge.exposeInMainWorld('aico', {
  pty: {
    start: (size: { cols: number; rows: number }) => ipcRenderer.send('pty:start', size),
    input: (data: string) => ipcRenderer.send('pty:input', data),
    resize: (size: { cols: number; rows: number }) => ipcRenderer.send('pty:resize', size),
    /** Ask tmux to re-send its authoritative grid (manual Refresh). Carries the
     * renderer's live grid size so main can re-pair a drifted pty first. */
    refresh: (size: { cols: number; rows: number }) => ipcRenderer.send('pty:refresh', size),
    /** Control-mode windows paste through tmux (bracketed when the program asks). */
    paste: (text: string) => ipcRenderer.send('pty:paste', text),
    onData: (cb: (data: string) => void) => {
      const listener = (_event: unknown, data: string) => cb(data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
  },
  terminal: {
    /** This window's terminal transport, fixed until the window reloads. */
    transport: (): Promise<'attach' | 'control'> => ipcRenderer.invoke('terminal:transport'),
    /** The transport new windows (and reloads) will use. */
    transportSetting: (): Promise<'attach' | 'control'> =>
      ipcRenderer.invoke('terminal:transport-setting'),
    /** Switch every window to the other transport; each reloads and reattaches. */
    toggleTransport: () => ipcRenderer.send('terminal:toggle-transport'),
  },
  links: {
    /** Open an http(s) URL in the default browser. */
    open: (url: string) => ipcRenderer.send('link:open', url),
  },
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    hasImage: (): Promise<boolean> => ipcRenderer.invoke('clipboard:has-image'),
    write: (text: string) => ipcRenderer.send('clipboard:write', text),
  },
  selection: {
    /** Fired when an indicated selection is delivered to this widget; drives the
     * frosted capture toast. Returns an unsubscribe function. */
    onToast: (cb: (sel: { kind: string; snippet: string }) => void) => {
      const listener = (_event: unknown, sel: { kind: string; snippet: string }) => cb(sel)
      ipcRenderer.on('selection:toast', listener)
      return () => ipcRenderer.removeListener('selection:toast', listener)
    },
  },
  context: {
    /** Supplemental-context availability for this widget's TUI, pushed by main
     * after launch/relaunch and on window load. Green means the source chain and
     * live delivery availability were independently verified; red means delivery
     * is unavailable or unconfirmed. It does not claim what an already-running
     * session received. `applicable` is false for TUIs with no mechanism, so the
     * badge hides for them. Returns an unsubscribe function. */
    onMandate: (
      cb: (s: { slug: string; state: string; detail: string; applicable: boolean }) => void,
    ) => {
      const listener = (
        _event: unknown,
        s: { slug: string; state: string; detail: string; applicable: boolean },
      ) => cb(s)
      ipcRenderer.on('context:mandate', listener)
      return () => ipcRenderer.removeListener('context:mandate', listener)
    },
  },
  voice: {
    /** Optional local voice websocket URL (resolved by main from env/default). */
    wsUrl: (): Promise<string> => ipcRenderer.invoke('voice:ws-url'),
    /** Push-to-talk toggle from the global hotkey; returns an unsubscribe function. */
    onToggle: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('voice:toggle', listener)
      return () => ipcRenderer.removeListener('voice:toggle', listener)
    },
  },
  actions: {
    /** Create a new widget running `tool` (TUI slug) in workspace `projectId`.
     * Both are explicit — a launch always names its tool and workspace. */
    newWidget: (tool: string, projectId: string) => ipcRenderer.send('widget:new', tool, projectId),
    /** Enabled TUIs (slug + label + accent + SVG mark), in registry order, for the picker. */
    listTuis: (): Promise<{ slug: string; displayName: string; accent: string; icon: string }[]> =>
      ipcRenderer.invoke('tui:list'),
    /** Replace the focused widget's running TUI with `tool` (respawns the pane). */
    loadTui: (tool: string) => ipcRenderer.send('widget:load-tui', tool),
    /** Aico workspace catalog for the "Open workspace" picker. */
    listProjects: (): Promise<{ id: string; name: string; root: string; current: boolean }[]> =>
      ipcRenderer.invoke('project:list'),
    /** Every running Tether session, whichever app started it. */
    listOpenableSessions: (): Promise<OpenableSession[]> =>
      ipcRenderer.invoke('session:list-openable'),
    openSession: (id: string): Promise<void> => ipcRenderer.invoke('session:open', id),
    /** Snapshot ownership, tmux, and resource diagnostics for the focused session. */
    sessionDiagnostics: (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('session:diagnostics'),
    /** Move the focused widget to workspace `id` (respawns its pane there, same tool). */
    switchProject: (id: string) => ipcRenderer.send('widget:switch-project', id),
    /** Hub view: surface every widget. */
    hub: () => ipcRenderer.send('widget:hub'),
    /** Harvest the freshest selection-bus capture and deliver it (same path as the hotkey). */
    indicate: () => ipcRenderer.send('selection:grab'),
    /** Fire a desktop grab from a click: aico-grab.sh flags (`-p` pick a window,
     * `-r` drag a region, `-t` OCR to text). The hotkeys grab the focused window;
     * a click picks/drags because Aico holds focus when you click the menu. */
    grab: (args: string[]) => ipcRenderer.send('grab:run', args),
    /** End the current session through Tether. */
    endSession: (): Promise<void> => ipcRenderer.invoke('session:end-self'),
    /** Mark or unmark this session as a coordinator (titlebar label, centre tile). */
    toggleCoordinator: () => ipcRenderer.send('widget:toggle-coordinator'),
  },
  settings: {
    /** Global pinned-action ids, or null if never set (first run). */
    getPins: (): Promise<string[] | null> => ipcRenderer.invoke('settings:get-pins'),
    /** Persist the pinned set; main broadcasts the change to every widget. */
    setPins: (ids: string[]) => ipcRenderer.send('settings:set-pins', ids),
    /** Subscribe to pin-set changes from any widget; returns an unsubscribe function. */
    onPinsChanged: (cb: (ids: string[]) => void) => {
      const listener = (_event: unknown, ids: string[]) => cb(ids)
      ipcRenderer.on('settings:pins-changed', listener)
      return () => ipcRenderer.removeListener('settings:pins-changed', listener)
    },
    /** Global terminal font settings, or null if never set. */
    getTerminalFont: () => ipcRenderer.invoke('settings:get-terminal-font'),
    /** Persist terminal font settings; main broadcasts the change to every widget. */
    setTerminalFont: (settings: unknown) =>
      ipcRenderer.send('settings:set-terminal-font', settings),
    /** Subscribe to terminal font changes from any widget; returns an unsubscribe function. */
    onTerminalFontChanged: (cb: (settings: unknown) => void) => {
      const listener = (_event: unknown, settings: unknown) => cb(settings)
      ipcRenderer.on('settings:terminal-font-changed', listener)
      return () => ipcRenderer.removeListener('settings:terminal-font-changed', listener)
    },
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    /** Set the window's outer bounds (px); used by the custom resize handles. */
    setBounds: (x: number, y: number, w: number, h: number) =>
      ipcRenderer.send('win:set-bounds', { x, y, w, h }),
    /** Report thinking-state transitions so the tray icon can reflect activity. */
    setThinking: (on: boolean) => ipcRenderer.send('win:thinking', on),
    /** Set this widget's title-bar name (empty clears it back to `Widget ${seq}`). */
    setName: (name: string) => ipcRenderer.send('widget:set-name', name),
    /** Subscribe to titlebar info (widget name + its TUI's SVG mark/accent/label)
     * pushed from main; returns an unsubscribe function. */
    onTitle: (
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
    ) => {
      const listener = (
        _event: unknown,
        info: {
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
        },
      ) => cb(info)
      ipcRenderer.on('win:title', listener)
      return () => ipcRenderer.removeListener('win:title', listener)
    },
    /** Subscribe to focus/blur; returns an unsubscribe function. */
    onFocusChange: (cb: (focused: boolean) => void) => {
      const listener = (_event: unknown, focused: boolean) => cb(focused)
      ipcRenderer.on('win:focus', listener)
      return () => ipcRenderer.removeListener('win:focus', listener)
    },
    /** Subscribe to the global cursor position (screen px) so the eyes can track
     * it while the window is unfocused; returns an unsubscribe function. */
    onCursor: (cb: (pt: { x: number; y: number }) => void) => {
      const listener = (_event: unknown, pt: { x: number; y: number }) => cb(pt)
      ipcRenderer.on('win:cursor', listener)
      return () => ipcRenderer.removeListener('win:cursor', listener)
    },
    /** Tell main where the eyes sit (client px) so other windows can look at them. */
    setEyeAnchor: (pt: { x: number; y: number }) => ipcRenderer.send('eyes:anchor', pt),
    /** Main asks the eyes to look at another window (screen px); returns an
     * unsubscribe function. */
    onPeerLook: (cb: (look: { x: number; y: number; delay: number; hold: number }) => void) => {
      const listener = (
        _event: unknown,
        look: { x: number; y: number; delay: number; hold: number },
      ) => cb(look)
      ipcRenderer.on('eyes:look', listener)
      return () => ipcRenderer.removeListener('eyes:look', listener)
    },
    onAttention: (
      cb: (attention: {
        mode: 'none' | 'blocked' | 'finished'
        stage: 'fresh' | 'rising' | 'urgent'
      }) => void,
    ) => {
      const listener = (
        _event: unknown,
        attention: { mode: 'none' | 'blocked' | 'finished'; stage: 'fresh' | 'rising' | 'urgent' },
      ) => cb(attention)
      ipcRenderer.on('eyes:attention', listener)
      return () => ipcRenderer.removeListener('eyes:attention', listener)
    },
  },
  arcade: {
    assign: (keys: string[]) => ipcRenderer.invoke('arcade:assign', keys),
    next: (keys: string[]) => ipcRenderer.invoke('arcade:next', keys),
    pick: (key: string, keys: string[]) => ipcRenderer.invoke('arcade:pick', key, keys),
    enabled: () => ipcRenderer.invoke('arcade:enabled'),
    toggle: () => ipcRenderer.send('arcade:toggle'),
    onEnabled: (cb: (on: boolean) => void) => {
      const listener = (_event: unknown, on: boolean) => cb(on)
      ipcRenderer.on('arcade:enabled', listener)
      return () => ipcRenderer.removeListener('arcade:enabled', listener)
    },
    onCursor: (cb: (pt: { x: number; y: number } | null) => void) => {
      const listener = (_event: unknown, pt: { x: number; y: number } | null) => cb(pt)
      ipcRenderer.on('arcade:cursor', listener)
      return () => ipcRenderer.removeListener('arcade:cursor', listener)
    },
  },
})
