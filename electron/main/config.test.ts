import { describe, expect, it } from 'vitest'
import { readConfig } from './config'

describe('readConfig', () => {
  it('uses the defaults with an empty environment', () => {
    expect(readConfig({}, '/home/o', 1234)).toEqual({
      stateDir: '/home/o/.local/state/aico',
      dbPath: '/home/o/.local/state/aico/aico.db',
      sidecarHost: '127.0.0.1',
      sidecarPort: 8005,
      layoutPath: '/run/user/1234/aico/layout.json',
      nightshift: '/home/o/.local/bin/nightshift',
      atermUrl: 'https://terminal.summitflow.dev',
      selectionHotkey: 'CommandOrControl+Shift+Space',
      voicePttHotkey: 'CommandOrControl+Shift+M',
      voiceWsUrl: 'ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico',
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
        XDG_RUNTIME_DIR: '/tmp/r',
        AICO_ATERM_URL: 'https://a.example',
        AICO_SELECTION_HOTKEY: 'F1',
        AICO_VOICE_HOTKEY: 'F2',
        AICO_VOICE_WS: 'ws://v',
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
      sidecarHost: '0.0.0.0',
      sidecarPort: 18905,
      layoutPath: '/tmp/r/aico/layout.json',
      atermUrl: 'https://a.example',
      selectionHotkey: 'F1',
      voicePttHotkey: 'F2',
      voiceWsUrl: 'ws://v',
      forcedTransport: 'attach',
      rendererUrl: 'http://localhost:5173',
      activationReadyFile: '/r/ready',
      pidFile: '/r/pid',
    })
    expect(readConfig({ AICO_TERMINAL_TRANSPORT: 'control' }, '/h', 1).forcedTransport).toBe(
      'control',
    )
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
