import { describe, expect, it } from 'vitest'
import {
  attachArgs,
  attachTargetArgs,
  captureArgs,
  capturePageTargetArgs,
  captureTargetArgs,
  HISTORY_LIMIT,
  hasSessionArgs,
  hasTargetArgs,
  IDLE_TTL_MS,
  isATermSessionName,
  killArgs,
  killTargetArgs,
  listActivityArgs,
  listArgs,
  listClientsArgs,
  listClientsTargetArgs,
  listDefaultPanesArgs,
  newDetachedArgs,
  panePidArgs,
  panePidTargetArgs,
  paneScrollbackInfoTargetArgs,
  refreshClientArgs,
  respawnArgs,
  scrollbackPageBounds,
  sendKeysArgs,
  sendTextArgs,
  sendTextTargetArgs,
  sessionName,
  staleWidgetIds,
  tmuxConf,
  tmuxProfileArgs,
  widgetIdFromSession,
} from './tmux'

describe('tmux model', () => {
  it('names sessions per widget', () => {
    expect(sessionName('7')).toBe('aico-7')
  })

  it('creates the session detached with conf, size, and cwd', () => {
    expect(newDetachedArgs('7', 200, 50, '/state/tmux.conf', '/home/me')).toEqual([
      '-L',
      'aico',
      '-f',
      '/state/tmux.conf',
      'new-session',
      '-d',
      '-s',
      'aico-7',
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      '/home/me',
    ])
  })

  it('attaches the client to an existing session (no relaunch)', () => {
    expect(attachArgs('7')).toEqual(['-L', 'aico', 'attach-session', '-t', 'aico-7'])
  })

  it('builds target commands for externally-owned default-socket sessions', () => {
    const target = { socket: null, session: 'summitflow-123e4567-e89b-12d3-a456-426614174000' }
    expect(attachTargetArgs(target)).toEqual([
      'attach-session',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
    ])
    expect(captureTargetArgs(target).slice(0, 3)).toEqual([
      'capture-pane',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
    ])
    expect(hasTargetArgs(target)).toEqual([
      'has-session',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
    ])
    expect(killTargetArgs(target)).toEqual([
      'kill-session',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
    ])
    expect(sendTextTargetArgs(target, 'hi')).toEqual([
      'send-keys',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
      '-l',
      'hi',
    ])
    expect(listClientsTargetArgs(target)).toEqual([
      'list-clients',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
      '-F',
      '#{client_name}',
    ])
    expect(panePidTargetArgs(target)).toEqual([
      'display-message',
      '-p',
      '-t',
      'summitflow-123e4567-e89b-12d3-a456-426614174000',
      '#{pane_pid}',
    ])
  })

  it('probes session existence and sends the launch line', () => {
    expect(hasSessionArgs('7')).toEqual(['-L', 'aico', 'has-session', '-t', 'aico-7'])
    expect(sendKeysArgs('7', 'claude')).toEqual([
      '-L',
      'aico',
      'send-keys',
      '-t',
      'aico-7',
      'claude',
      'Enter',
    ])
  })

  it('respawns the pane (kills the running TUI) in cwd for "Replace with"', () => {
    expect(respawnArgs('7', '/home/me')).toEqual([
      '-L',
      'aico',
      'respawn-pane',
      '-k',
      '-c',
      '/home/me',
      '-t',
      'aico-7',
    ])
  })

  it('inserts selection text literally with no trailing Enter', () => {
    expect(sendTextArgs('7', '[dom: "hi"] ')).toEqual([
      '-L',
      'aico',
      'send-keys',
      '-t',
      'aico-7',
      '-l',
      '[dom: "hi"] ',
    ])
  })

  it('sets a high history limit in the conf read at server start', () => {
    expect(tmuxConf()).toContain(`set -g history-limit ${HISTORY_LIMIT}`)
  })

  it('turns the tmux status bar off (Aico draws its own chrome)', () => {
    expect(tmuxConf()).toContain('set -g status off')
  })

  it('advertises truecolor tmux capabilities and clears inherited no-color env', () => {
    expect(tmuxConf()).toContain('set -g default-terminal "tmux-256color"')
    expect(tmuxConf()).toContain('set -g terminal-overrides ",xterm-256color:Tc"')
    expect(tmuxConf()).toContain('set -g terminal-features "xterm*:sync"')
    expect(tmuxConf()).toContain('set-environment -gu NO_COLOR')
    expect(tmuxConf()).toContain('set-environment -g COLORTERM truecolor')
  })

  it('builds runtime profile commands for an already-running tmux server', () => {
    expect(tmuxProfileArgs()).toContainEqual(['-L', 'aico', 'set-environment', '-gu', 'NO_COLOR'])
    expect(tmuxProfileArgs()).toContainEqual([
      '-L',
      'aico',
      'set-option',
      '-g',
      'terminal-overrides',
      ',xterm-256color:Tc',
    ])
  })

  it('captures the whole scrollback with colors for the overlay', () => {
    expect(captureArgs('7')).toEqual([
      '-L',
      'aico',
      'capture-pane',
      '-t',
      'aico-7',
      '-p',
      '-e',
      '-S',
      '-',
      '-E',
      '-',
    ])
  })

  it('captures bounded scrollback pages by absolute line range', () => {
    const target = { socket: 'aico', session: 'aico-7' }
    const tail = scrollbackPageBounds(1000, 40, 100)
    expect(tail).toEqual({
      fromLine: 940,
      toLineExclusive: 1040,
      totalLines: 1040,
      startCoord: -60,
      endCoord: 39,
    })
    expect(capturePageTargetArgs(target, tail as NonNullable<typeof tail>)).toEqual([
      '-L',
      'aico',
      'capture-pane',
      '-t',
      'aico-7',
      '-p',
      '-e',
      '-S',
      '-60',
      '-E',
      '39',
    ])

    expect(scrollbackPageBounds(1000, 40, 100, 200)).toMatchObject({
      fromLine: 200,
      toLineExclusive: 300,
      startCoord: -800,
      endCoord: -701,
    })
  })

  it('reads pane history size and height for scrollback paging', () => {
    expect(paneScrollbackInfoTargetArgs({ socket: 'aico', session: 'aico-7' })).toEqual([
      '-L',
      'aico',
      'display-message',
      '-p',
      '-t',
      'aico-7',
      '#{history_size} #{pane_height}',
    ])
  })

  it('lists and kills sessions on the isolated socket', () => {
    expect(listArgs()).toEqual([
      '-L',
      'aico',
      'list-sessions',
      '-F',
      '#{session_name} #{session_created}',
    ])
    expect(killArgs('7')).toEqual(['-L', 'aico', 'kill-session', '-t', 'aico-7'])
  })

  it('recovers the widget id from a session name (for orphan adoption)', () => {
    expect(widgetIdFromSession('aico-7')).toBe('7')
    expect(widgetIdFromSession('aico-a3f9c2e1')).toBe('a3f9c2e1')
    expect(widgetIdFromSession('other-session')).toBeNull()
  })

  it("lists a session's attached clients and refreshes one for the manual Refresh", () => {
    expect(listClientsArgs('7')).toEqual([
      '-L',
      'aico',
      'list-clients',
      '-t',
      'aico-7',
      '-F',
      '#{client_name}',
    ])
    expect(refreshClientArgs('/dev/pts/3')).toEqual([
      '-L',
      'aico',
      'refresh-client',
      '-t',
      '/dev/pts/3',
    ])
  })

  it("reads the widget pane's root pid for live TUI detection", () => {
    expect(panePidArgs('7')).toEqual([
      '-L',
      'aico',
      'display-message',
      '-p',
      '-t',
      'aico-7',
      '#{pane_pid}',
    ])
  })

  it('identifies A-Term managed sessions on the default tmux server', () => {
    expect(isATermSessionName('summitflow-123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isATermSessionName('aico-123e4567-e89b-12d3-a456-426614174000')).toBe(false)
  })

  it('lists default-server panes for attachable discovery', () => {
    expect(listDefaultPanesArgs()).toEqual([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}',
    ])
  })

  it('lists session activity + attachment for the idle reaper', () => {
    expect(listActivityArgs()).toEqual([
      '-L',
      'aico',
      'list-sessions',
      '-F',
      '#{session_name} #{session_activity} #{session_attached}',
    ])
  })
})

describe('idle session reaper', () => {
  const now = 1_700_000_000_000 // fixed "now" in ms
  const sec = (msAgo: number) => String(Math.floor((now - msAgo) / 1000))

  it('reaps unattached sessions idle past the TTL', () => {
    const lines = `aico-old ${sec(IDLE_TTL_MS + 60_000)} 0`
    expect(staleWidgetIds(lines, now, IDLE_TTL_MS)).toEqual(['old'])
  })

  it('keeps fresh sessions', () => {
    const lines = `aico-fresh ${sec(60_000)} 0`
    expect(staleWidgetIds(lines, now, IDLE_TTL_MS)).toEqual([])
  })

  it('never reaps an attached session, however idle', () => {
    const lines = `aico-busy ${sec(IDLE_TTL_MS * 10)} 1`
    expect(staleWidgetIds(lines, now, IDLE_TTL_MS)).toEqual([])
  })

  it('ignores non-aico sessions and malformed lines', () => {
    const lines = [
      `other ${sec(IDLE_TTL_MS + 1)} 0`, // foreign session
      `aico-bad notanumber 0`, // unparseable activity → kept
      ``, // blank
      `aico-stale ${sec(IDLE_TTL_MS + 1)} 0`,
    ].join('\n')
    expect(staleWidgetIds(lines, now, IDLE_TTL_MS)).toEqual(['stale'])
  })
})
