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
      tetherSockets: [
        '/run/user/1234/tether/default/control.sock',
        '/run/tether/agent/default/control.sock',
      ],
      agentTetherSocket: '/run/tether/agent/default/control.sock',
      exchangeRoot: '/srv/workspaces/exchange',
      pastedImages: { dir: '/srv/workspaces/exchange/owner/pasted-images', maxAgeMs: 86_400_000 },
      nightshift: '/home/o/.local/bin/nightshift',
      atermUrl: 'https://terminal.summitflow.dev',
      selectionHotkey: 'CommandOrControl+Shift+Space',
      rendererUrl: undefined,
      activationReadyFile: undefined,
      pidFile: undefined,
    })
  })

  it('keeps pasted images under the configured owner exchange by default', () => {
    expect(readConfig({ TETHER_EXCHANGE_ROOT: '/exchange' }, '/h', 1).pastedImages.dir).toBe(
      '/exchange/owner/pasted-images',
    )
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
        TETHER_EXCHANGE_ROOT: '/exchange',
        AICO_PASTED_IMAGES_DIR: '/pasted',
        AICO_PASTED_IMAGES_KEEP_HOURS: '2',
        AICO_ATERM_URL: 'https://a.example',
        AICO_SELECTION_HOTKEY: 'F1',
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
      tetherSockets: ['/tmp/r/tether/dev/control.sock', '/run/tether/agent/default/control.sock'],
      exchangeRoot: '/exchange',
      pastedImages: { dir: '/pasted', maxAgeMs: 7_200_000 },
      atermUrl: 'https://a.example',
      selectionHotkey: 'F1',
      rendererUrl: 'http://localhost:5173',
      activationReadyFile: '/r/ready',
      pidFile: '/r/pid',
    })
  })

  it('keeps pasted images a day unless the hours are a positive number', () => {
    for (const raw of ['', '0', '-3', 'abc']) {
      expect(
        readConfig({ AICO_PASTED_IMAGES_KEEP_HOURS: raw }, '/h', 1).pastedImages.maxAgeMs,
      ).toBe(86_400_000)
    }
  })

  it('turns a listener port that is not plain digits in 1-65535 into NaN', () => {
    for (const raw of ['', '0', '0x1f45', '1e3', ' 8005 ', '8005.0', '-1', '65536', 'abc']) {
      expect(readConfig({ AICO_SIDECAR_PORT: raw }, '/h', 1).listenerPort).toBeNaN()
    }
    expect(readConfig({ AICO_SIDECAR_PORT: '1' }, '/h', 1).listenerPort).toBe(1)
    expect(readConfig({ AICO_SIDECAR_PORT: '65535' }, '/h', 1).listenerPort).toBe(65535)
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
