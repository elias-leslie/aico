import { contextBridge, ipcRenderer } from 'electron'

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
    onData: (cb: (data: string) => void) => {
      const listener = (_event: unknown, data: string) => cb(data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
  },
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    write: (text: string) => ipcRenderer.send('clipboard:write', text),
  },
  scrollback: {
    capture: (): Promise<string> => ipcRenderer.invoke('tmux:capture'),
    page: (request?: { fromLine?: number; count?: number }) =>
      ipcRenderer.invoke('tmux:scrollback-page', request),
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
    /** Enabled TUIs (slug + label + accent), in registry order, for the picker. */
    listTuis: (): Promise<{ slug: string; displayName: string; accent: string }[]> =>
      ipcRenderer.invoke('tui:list'),
    /** Replace the focused widget's running TUI with `tool` (respawns the pane). */
    loadTui: (tool: string) => ipcRenderer.send('widget:load-tui', tool),
    /** Aico workspace catalog for the "Open workspace" picker. */
    listProjects: (): Promise<{ id: string; name: string; root: string; current: boolean }[]> =>
      ipcRenderer.invoke('project:list'),
    /** Externally-owned tmux sessions Aico can attach without taking ownership. */
    listTmuxSessions: (): Promise<{ id: string; label: string; source: string }[]> =>
      ipcRenderer.invoke('tmux:list-attachable'),
    /** Attach an externally-owned tmux session as a widget. */
    attachTmuxSession: (id: string) => ipcRenderer.send('tmux:attach', id),
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
    /** Retire this widget: close the window AND end its tmux session. */
    retire: () => ipcRenderer.send('widget:discard-self'),
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
  },
})
