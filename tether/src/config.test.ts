import { describe, expect, it } from 'vitest'
import {
  ownsTmuxServerUnit,
  paneExitMarkerPath,
  resolvePaths,
  tmuxServerSocketPath,
  tmuxServerUnit,
} from './config'

const env = { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' }
const id = '06e633492f792ad10439f675491801ee'

describe('resolvePaths', () => {
  it('keeps Aico compatibility paths only for the default instance', () => {
    const paths = resolvePaths({ env, uid: 1000 })
    expect(paths.instance).toBe('default')
    expect(paths.stateDir).toBe('/home/u/.local/state/tether/default')
    expect(paths.dbPath).toBe('/home/u/.local/state/tether/default/tether.db')
    expect(paths.socket).toBe('/run/user/1000/tether/default/control.sock')
    expect(paths.paneExitMarkerDir).toBe('/run/user/1000/aico')
    expect(paths.legacyControlSocket).toBe('/run/user/1000/aico/control.sock')
    expect(paths.legacyGuiSocket).toBe('/run/user/1000/aico/gui-control.sock')
    expect(paths.historicalTmuxSocket).toBe('/tmp/tmux-1000/aico')
    expect(tmuxServerSocketPath(paths, id)).toBe(
      `/home/u/.local/state/tether/default/tmux/${id}/server.sock`,
    )
    expect(paneExitMarkerPath(paths, id)).toBe(`/run/user/1000/aico/pane-exited-${id}`)
  })

  it('puts the instance name into every location of other instances', () => {
    const paths = resolvePaths({ instance: 'dev', env, uid: 1000 })
    expect(paths.legacy).toBe(false)
    expect(paths.stateDir).toBe('/home/u/.local/state/tether/dev')
    expect(paths.socket).toBe('/run/user/1000/tether/dev/control.sock')
    expect(paths.paneExitMarkerDir).toBe('/run/user/1000/tether/dev/pane-exits')
    expect(paths.legacyControlSocket).toBeNull()
    expect(paths.legacyGuiSocket).toBeNull()
    expect(paths.historicalTmuxSocket).toBeNull()
  })

  it('rejects unsafe instance names and overlong socket paths', () => {
    expect(() => resolvePaths({ instance: '../x', env, uid: 1000 })).toThrow()
    expect(() => resolvePaths({ instance: 'Dev', env, uid: 1000 })).toThrow()
    expect(() =>
      resolvePaths({ env: { ...env, TETHER_STATE_DIR: `/${'x'.repeat(90)}` }, uid: 1000 }),
    ).toThrow(/socket path/)
  })
})

describe('tmux server units', () => {
  it('uses Aico unit names for default and instance-scoped names otherwise', () => {
    expect(tmuxServerUnit('default', id)).toBe(`aico-tmux-server-${id}.service`)
    expect(tmuxServerUnit('dev', id)).toBe(`tether-dev-tmux-server-${id}.service`)
    expect(() => tmuxServerUnit('dev', 'XYZ')).toThrow()
  })

  it('never reconciles another instance', () => {
    expect(ownsTmuxServerUnit('default', `aico-tmux-server-${id}.scope`)).toBe(true)
    expect(ownsTmuxServerUnit('default', `tether-dev-tmux-server-${id}.service`)).toBe(false)
    expect(ownsTmuxServerUnit('dev', `aico-tmux-server-${id}.service`)).toBe(false)
    expect(ownsTmuxServerUnit('dev', `tether-dev-tmux-server-${id}.service`)).toBe(true)
    expect(ownsTmuxServerUnit('dev', `tether-dev-2-tmux-server-${id}.service`)).toBe(false)
  })
})
