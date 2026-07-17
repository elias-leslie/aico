import { describe, expect, it } from 'vitest'
import {
  A_TERM_SESSION_PREFIX,
  attachArgs,
  attachTargetArgs,
  captureArgs,
  capturePageTargetArgs,
  captureTargetArgs,
  HISTORY_LIMIT,
  hasSessionArgs,
  hasTargetArgs,
  isATermSessionName,
  isDefinitiveTmuxAbsence,
  isTmuxTransportUnavailable,
  killArgs,
  killTargetArgs,
  listArgs,
  listClientsArgs,
  listClientsTargetArgs,
  listDefaultPanesArgs,
  listSessionPanesArgs,
  listSessionPanesTargetArgs,
  matchesServerIdentityEnvironment,
  newDetachedArgs,
  PANE_GATE_COMMAND,
  paneExitedEventPath,
  paneExitedHookCommand,
  paneExitedHookTargetArgs,
  panePidArgs,
  panePidTargetArgs,
  paneScrollbackInfoTargetArgs,
  refreshClientArgs,
  resolveInternalTmuxSocket,
  respawnArgs,
  respawnTargetArgs,
  runInPaneArgs,
  runInPaneTargetArgs,
  scrollbackPageBounds,
  sendTextArgs,
  sendTextTargetArgs,
  serverIdentityEnvironmentTargetArgs,
  sessionIdArgs,
  sessionIdTargetArgs,
  sessionName,
  showPaneExitedHookTargetArgs,
  TMUX_SOCKET,
  tmuxConf,
  tmuxProfileArgs,
  widgetIdFromSession,
} from './tmux'

const EXTERNAL_A_TERM_SESSION = `${A_TERM_SESSION_PREFIX}123e4567-e89b-12d3-a456-426614174000`
const INTERNAL_SOCKET_ARGS = ['-S', TMUX_SOCKET]

describe('tmux model', () => {
  it('distinguishes definitive absence from unsafe unknown client failures', () => {
    expect(isDefinitiveTmuxAbsence("can't find session: aico-dead")).toBe(true)
    expect(isDefinitiveTmuxAbsence("prefix: can't find session: aico-dead")).toBe(false)
    expect(
      isDefinitiveTmuxAbsence(
        'error connecting to /tmp/tmux-1000/aico (No such file or directory)',
      ),
    ).toBe(false)
    expect(isDefinitiveTmuxAbsence('no server running on /tmp/tmux-1000/aico')).toBe(false)
    expect(isDefinitiveTmuxAbsence('permission denied')).toBe(false)
    expect(isDefinitiveTmuxAbsence('client timed out')).toBe(false)
  })

  it('classifies unavailable transport without granting session-absence authority', () => {
    const enoent = 'error connecting to /tmp/tmux-1000/aico (No such file or directory)'
    const noServer = 'no server running on /tmp/tmux-1000/aico'
    expect(isTmuxTransportUnavailable(enoent)).toBe(true)
    expect(isTmuxTransportUnavailable(noServer)).toBe(true)
    expect(isDefinitiveTmuxAbsence(enoent)).toBe(false)
    expect(isDefinitiveTmuxAbsence(noServer)).toBe(false)
    expect(isTmuxTransportUnavailable("can't find session: aico-dead")).toBe(false)
  })

  it('resolves the production label to its canonical absolute historical path', () => {
    expect(resolveInternalTmuxSocket(undefined, 1000)).toBe('/tmp/tmux-1000/aico')
    expect(resolveInternalTmuxSocket('aico-test-123', 1000)).toBe('/tmp/tmux-1000/aico-test-123')
    expect(resolveInternalTmuxSocket('/tmp/aico-test-123/tmux.sock', 1000)).toBe(
      '/tmp/aico-test-123/tmux.sock',
    )
  })

  it('rejects empty, traversing, control-character, and overlong socket overrides', () => {
    for (const unsafe of [
      '',
      '../aico',
      'nested/aico',
      'aico test',
      'aico\nother',
      '/tmp/../aico',
      '/tmp//aico',
      `/tmp/${'a'.repeat(108)}`,
    ]) {
      expect(() => resolveInternalTmuxSocket(unsafe, 1000), unsafe).toThrow()
    }
  })

  it('names sessions per widget', () => {
    expect(sessionName('7')).toBe('aico-7')
  })

  it('authenticates an empty managed server through bounded global markers', () => {
    const socket = '/tmp/aico-test/server.sock'
    expect(serverIdentityEnvironmentTargetArgs(socket)).toEqual([
      '-S',
      socket,
      'show-environment',
      '-g',
      'AICO_OWNER',
      ';',
      'show-environment',
      '-g',
      'AICO_WORKLOAD_CLASS',
      ';',
      'show-environment',
      '-g',
      'AICO_TMUX_SERVER_ID',
    ])
    const identity =
      'AICO_OWNER=aico\n' +
      'AICO_WORKLOAD_CLASS=durable-tmux-server\n' +
      'AICO_TMUX_SERVER_ID=11111111111111111111111111111111\n'
    expect(matchesServerIdentityEnvironment(identity, '11111111111111111111111111111111')).toBe(
      true,
    )
    expect(matchesServerIdentityEnvironment(identity, '22222222222222222222222222222222')).toBe(
      false,
    )
  })

  it('creates the session detached with conf, size, cwd, and a no-RC gate shell', () => {
    expect(newDetachedArgs('7', 200, 50, '/state/tmux.conf', '/home/me')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
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
      PANE_GATE_COMMAND,
    ])
  })

  it('injects ownership metadata before the fixed gate command', () => {
    expect(
      newDetachedArgs('7', 200, 50, '/state/tmux.conf', '/home/me', {
        AICO_SESSION_ID: 'aico-widget-7',
        AICO_OWNER: 'aico',
      }),
    ).toEqual([
      ...INTERNAL_SOCKET_ARGS,
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
      '-e',
      'AICO_SESSION_ID=aico-widget-7',
      '-e',
      'AICO_OWNER=aico',
      PANE_GATE_COMMAND,
    ])
  })

  it('launches the TUI only through an already-created pane', () => {
    expect(runInPaneArgs('7', 'claude; exec sh')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'send-keys',
      '-t',
      'aico-7',
      'C-u',
      ';',
      'send-keys',
      '-t',
      'aico-7',
      '-l',
      'claude; exec sh',
      ';',
      'send-keys',
      '-t',
      'aico-7',
      'Enter',
    ])
  })

  it('attaches the client to an existing session (no relaunch)', () => {
    expect(attachArgs('7')).toEqual([...INTERNAL_SOCKET_ARGS, 'attach-session', '-t', 'aico-7'])
  })

  it('uses validated -S paths and rejects unsafe target socket references', () => {
    expect(hasTargetArgs({ socket: '/tmp/aico-test/tmux.sock', session: 'aico-7' })).toEqual([
      '-S',
      '/tmp/aico-test/tmux.sock',
      'has-session',
      '-t',
      'aico-7',
    ])
    expect(hasTargetArgs({ socket: 'safe-label', session: 'aico-7' }).slice(0, 2)).toEqual([
      '-L',
      'safe-label',
    ])
    expect(() => hasTargetArgs({ socket: '', session: 'aico-7' })).toThrow()
    expect(() => hasTargetArgs({ socket: '../unsafe', session: 'aico-7' })).toThrow()
    expect(() => hasTargetArgs({ socket: '/tmp/../unsafe', session: 'aico-7' })).toThrow()
  })

  it('builds target commands for externally-owned default-socket sessions', () => {
    const target = { socket: null, session: EXTERNAL_A_TERM_SESSION }
    expect(attachTargetArgs(target)).toEqual(['attach-session', '-t', EXTERNAL_A_TERM_SESSION])
    expect(captureTargetArgs(target).slice(0, 3)).toEqual([
      'capture-pane',
      '-t',
      EXTERNAL_A_TERM_SESSION,
    ])
    expect(hasTargetArgs(target)).toEqual(['has-session', '-t', EXTERNAL_A_TERM_SESSION])
    expect(killTargetArgs(target)).toEqual(['kill-session', '-t', EXTERNAL_A_TERM_SESSION])
    expect(sendTextTargetArgs(target, 'hi')).toEqual([
      'send-keys',
      '-t',
      EXTERNAL_A_TERM_SESSION,
      '-l',
      'hi',
    ])
    expect(listClientsTargetArgs(target)).toEqual([
      'list-clients',
      '-t',
      EXTERNAL_A_TERM_SESSION,
      '-F',
      '#{client_name}',
    ])
    expect(panePidTargetArgs(target)).toEqual([
      'display-message',
      '-p',
      '-t',
      EXTERNAL_A_TERM_SESSION,
      '#{pane_pid}',
    ])
    expect(sessionIdTargetArgs(target)).toEqual([
      'display-message',
      '-p',
      '-t',
      EXTERNAL_A_TERM_SESSION,
      '#{session_id}',
    ])
    expect(listSessionPanesTargetArgs(target)).toEqual([
      'list-panes',
      '-t',
      EXTERNAL_A_TERM_SESSION,
      '-F',
      '#{pane_id}\t#{pane_pid}',
    ])
  })

  it('probes session existence', () => {
    expect(hasSessionArgs('7')).toEqual([...INTERNAL_SOCKET_ARGS, 'has-session', '-t', 'aico-7'])
  })

  it('respawns the pane (kills the running TUI) in cwd for "Replace with"', () => {
    expect(respawnArgs('7', '/home/me')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'respawn-pane',
      '-k',
      '-c',
      '/home/me',
      '-t',
      'aico-7',
      PANE_GATE_COMMAND,
    ])
  })

  it('respawns into the gate with refreshed ownership metadata', () => {
    expect(respawnArgs('7', '/home/me', { AICO_SESSION_ID: 'aico-widget-7' })).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'respawn-pane',
      '-k',
      '-c',
      '/home/me',
      '-t',
      'aico-7',
      '-e',
      'AICO_SESSION_ID=aico-widget-7',
      PANE_GATE_COMMAND,
    ])
  })

  it('targets respawn and post-verification launch by stable tmux identity', () => {
    const target = { socket: TMUX_SOCKET, session: '%9' }
    expect(respawnTargetArgs(target, '/home/me')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'respawn-pane',
      '-k',
      '-c',
      '/home/me',
      '-t',
      '%9',
      PANE_GATE_COMMAND,
    ])
    expect(runInPaneTargetArgs(target, 'exec codex')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'send-keys',
      '-t',
      '%9',
      'C-u',
      ';',
      'send-keys',
      '-t',
      '%9',
      '-l',
      'exec codex',
      ';',
      'send-keys',
      '-t',
      '%9',
      'Enter',
    ])
  })

  it('inserts selection text literally with no trailing Enter', () => {
    expect(sendTextArgs('7', '[dom: "hi"] ')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
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

  it('builds one chained profile command for an already-running tmux server', () => {
    const args = tmuxProfileArgs()
    expect(args.slice(0, 2)).toEqual(INTERNAL_SOCKET_ARGS)
    expect(args.join(' ')).toContain('set-environment -gu NO_COLOR')
    expect(args.join(' ')).toContain('set-option -g terminal-overrides ,xterm-256color:Tc')
    // tmux's `;` separator chains the per-option commands into a single spawn.
    expect(args.filter((a) => a === ';')).toHaveLength(8)
  })

  it('builds a generation-specific durable pane-exited event hook on one exact socket', () => {
    const socket = '/tmp/aico-test/tmux.sock'
    const serverId = '0123456789abcdef'

    expect(paneExitedEventPath(serverId, 1000)).toBe(
      '/run/user/1000/aico/pane-exited-0123456789abcdef',
    )
    expect(paneExitedHookTargetArgs(socket, serverId, 1000)).toEqual([
      '-S',
      socket,
      'set-hook',
      '-g',
      'pane-exited',
      'run-shell "/usr/bin/touch /run/user/1000/aico/pane-exited-0123456789abcdef"',
    ])
    expect(paneExitedHookCommand(serverId, 1000)).toBe(
      'run-shell "/usr/bin/touch /run/user/1000/aico/pane-exited-0123456789abcdef"',
    )
    expect(showPaneExitedHookTargetArgs(socket)).toEqual([
      '-S',
      socket,
      'show-options',
      '-gHqv',
      'pane-exited',
    ])
  })

  it('rejects unsafe pane-exited generation IDs and non-absolute hook sockets', () => {
    for (const serverId of [
      '',
      'abcdef0',
      'ABCDEF12',
      'not-hex!!',
      'deadbeef; kill-server',
      'a'.repeat(65),
    ]) {
      expect(
        () => paneExitedHookTargetArgs('/tmp/aico-test/tmux.sock', serverId, 1000),
        serverId,
      ).toThrow('invalid tmux server generation id')
      expect(() => paneExitedEventPath(serverId, 1000), serverId).toThrow(
        'invalid tmux server generation id',
      )
    }

    expect(() => paneExitedHookTargetArgs('aico', '01234567', 1000)).toThrow(
      'tmux socket path must be absolute',
    )
    expect(() => showPaneExitedHookTargetArgs('aico')).toThrow('tmux socket path must be absolute')
    expect(() => paneExitedEventPath('01234567', -1)).toThrow('unsafe tmux uid')
  })

  it('captures the whole scrollback with colors for the overlay', () => {
    expect(captureArgs('7')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
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
    const target = { socket: TMUX_SOCKET, session: 'aico-7' }
    const tail = scrollbackPageBounds(1000, 40, 100)
    expect(tail).toEqual({
      fromLine: 940,
      toLineExclusive: 1040,
      totalLines: 1040,
      startCoord: -60,
      endCoord: 39,
    })
    expect(capturePageTargetArgs(target, tail as NonNullable<typeof tail>)).toEqual([
      ...INTERNAL_SOCKET_ARGS,
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
    expect(paneScrollbackInfoTargetArgs({ socket: TMUX_SOCKET, session: 'aico-7' })).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'display-message',
      '-p',
      '-t',
      'aico-7',
      '#{history_size} #{pane_height}',
    ])
  })

  it('lists and kills sessions on the isolated socket', () => {
    expect(listArgs()).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'list-sessions',
      '-F',
      '#{session_name} #{session_created}',
    ])
    expect(killArgs('7')).toEqual([...INTERNAL_SOCKET_ARGS, 'kill-session', '-t', 'aico-7'])
  })

  it('recovers the widget id from a session name (for orphan adoption)', () => {
    expect(widgetIdFromSession('aico-7')).toBe('7')
    expect(widgetIdFromSession('aico-a3f9c2e1')).toBe('a3f9c2e1')
    expect(widgetIdFromSession('other-session')).toBeNull()
  })

  it("lists a session's attached clients and refreshes one for the manual Refresh", () => {
    expect(listClientsArgs('7')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'list-clients',
      '-t',
      'aico-7',
      '-F',
      '#{client_name}',
    ])
    expect(refreshClientArgs('/dev/pts/3')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'refresh-client',
      '-t',
      '/dev/pts/3',
    ])
  })

  it("reads the widget pane's root pid for live TUI detection", () => {
    expect(panePidArgs('7')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'display-message',
      '-p',
      '-t',
      'aico-7',
      '#{pane_pid}',
    ])
  })

  it('reads stable internal session identity and enumerates every pane identity', () => {
    expect(sessionIdArgs('7')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'display-message',
      '-p',
      '-t',
      'aico-7',
      '#{session_id}',
    ])
    expect(listSessionPanesArgs('7')).toEqual([
      ...INTERNAL_SOCKET_ARGS,
      'list-panes',
      '-t',
      'aico-7',
      '-F',
      '#{pane_id}\t#{pane_pid}',
    ])
  })

  it('identifies A-Term managed sessions on the default tmux server', () => {
    expect(isATermSessionName(EXTERNAL_A_TERM_SESSION)).toBe(true)
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
})
