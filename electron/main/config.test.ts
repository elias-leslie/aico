import { describe, expect, it } from 'vitest'
import { readConfig } from './config'

describe('readConfig', () => {
  it('uses the defaults with an empty environment', () => {
    expect(readConfig({}, '/home/o', 1234)).toEqual({
      stateDir: '/home/o/.local/state/aico',
      dbPath: '/home/o/.local/state/aico/aico.db',
      listenerHost: '127.0.0.1',
      listenerPort: 8005,
      extensionIds: undefined,
      layoutPath: '/run/user/1234/aico/layout.json',
      tetherSocket: '/run/user/1234/tether/default/control.sock',
      nightshift: '/home/o/.local/bin/nightshift',
      atermUrl: 'https://terminal.summitflow.dev',
      selectionHotkey: 'CommandOrControl+Shift+Space',
      forcedTransport: undefined,
      rendererUrl: undefined,
      activationReadyFile: undefined,
      pidFile: undefined,
    })
  })

  it('takes every override from the environment', () => {
    const config = readConfig(
      {
        AICO_STATE_DIR: '/s',
        AICO_SIDECAR_HOST: '0.0.0.0',
        AICO_SIDECAR_PORT: '18905',
        AICO_EXTENSION_IDS: 'x',
        XDG_RUNTIME_DIR: '/tmp/r',
        TETHER_INSTANCE: 'dev',
        AICO_ATERM_URL: 'https://a.example',
        AICO_SELECTION_HOTKEY: 'F1',
        AICO_TERMINAL_TRANSPORT: 'attach',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
        AICO_ACTIVATION_READY_FILE: '/r/ready',
        AICO_PIDFILE: '/r/pid',
      },
      '/home/o',
      1234,
    )
    expect(config).toMatchObject({
      stateDir: '/s',
      dbPath: '/s/aico.db',
      listenerHost: '0.0.0.0',
      listenerPort: 18905,
      extensionIds: 'x',
      layoutPath: '/tmp/r/aico/layout.json',
      tetherSocket: '/tmp/r/tether/dev/control.sock',
      atermUrl: 'https://a.example',
      selectionHotkey: 'F1',
      forcedTransport: 'attach',
      rendererUrl: 'http://localhost:5173',
      activationReadyFile: '/r/ready',
      pidFile: '/r/pid',
    })
    expect(readConfig({ AICO_TERMINAL_TRANSPORT: 'control' }, '/h', 1).forcedTransport).toBe(
      'control',
    )
  })

  it('turns a listener port that is not plain digits in 1-65535 into NaN', () => {
    for (const raw of ['', '0', '0x1f45', '1e3', ' 8005 ', '8005.0', '-1', '65536', 'abc']) {
      expect(readConfig({ AICO_SIDECAR_PORT: raw }, '/h', 1).listenerPort).toBeNaN()
    }
    expect(readConfig({ AICO_SIDECAR_PORT: '1' }, '/h', 1).listenerPort).toBe(1)
    expect(readConfig({ AICO_SIDECAR_PORT: '65535' }, '/h', 1).listenerPort).toBe(65535)
  })

  it('ignores a terminal transport it does not know', () => {
    expect(readConfig({ AICO_TERMINAL_TRANSPORT: 'pty' }, '/h', 1).forcedTransport).toBeUndefined()
  })

  it('strips trailing slashes from the a-term URL', () => {
    expect(readConfig({ AICO_ATERM_URL: 'https://a.example///' }, '/h', 1).atermUrl).toBe(
      'https://a.example',
    )
  })

  it('falls back to /run/user/<uid> when XDG_RUNTIME_DIR is unset or empty', () => {
    expect(readConfig({ XDG_RUNTIME_DIR: '' }, '/h', 1000).layoutPath).toBe(
      '/run/user/1000/aico/layout.json',
    )
    expect(readConfig({}, '/h', undefined).layoutPath).toBe('/run/user/1000/aico/layout.json')
  })

  it('is frozen', () => {
    expect(Object.isFrozen(readConfig({}, '/h', 1))).toBe(true)
  })
})
