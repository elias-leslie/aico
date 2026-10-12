import { describe, expect, it } from 'vitest'
import {
  cleanEnvArgv,
  FILTERED_ENV_VARS,
  parseGraphicalEnvironment,
  passthroughFromEnv,
  sessionEnvironment,
  tmuxServerEnvironment,
} from './env'

describe('tmuxServerEnvironment', () => {
  it('keeps only allow-listed names and drops secrets and nesting markers', () => {
    const env = tmuxServerEnvironment({
      HOME: '/home/u',
      PATH: '/usr/bin',
      LC_ALL: 'en_US.UTF-8',
      XDG_RUNTIME_DIR: '/run/user/1000',
      OPENAI_API_KEY: 'secret',
      DATABASE_URL: 'postgres://x',
      TMUX: '/tmp/tmux-1000/default,1,0',
      NO_COLOR: '1',
      ELECTRON_RUN_AS_NODE: '1',
      RANDOM_APP_SETTING: 'x',
    })
    expect(env).toMatchObject({ HOME: '/home/u', PATH: '/usr/bin', LC_ALL: 'en_US.UTF-8' })
    for (const name of [
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'TMUX',
      'NO_COLOR',
      'ELECTRON_RUN_AS_NODE',
      'RANDOM_APP_SETTING',
    ]) {
      expect(env).not.toHaveProperty(name)
    }
    expect(env.COLORTERM).toBe('truecolor')
  })

  it('never passes a filtered secret even when an operator allow-lists it', () => {
    const extra = passthroughFromEnv({ TETHER_ENV_PASSTHROUGH: 'GITHUB_TOKEN, MY_VAR,bad name' })
    expect([...extra]).toEqual(['GITHUB_TOKEN', 'MY_VAR'])
    const env = tmuxServerEnvironment({ GITHUB_TOKEN: 't', MY_VAR: 'v' }, extra)
    expect(env).toEqual(expect.objectContaining({ MY_VAR: 'v' }))
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
  })

  it("is a superset of A-Term's FILTERED_ENV_VARS", () => {
    for (const name of [
      'DATABASE_URL',
      'CF_ACCESS_CLIENT_SECRET',
      'ANTHROPIC_API_KEY',
      'DISCORD_TOKEN',
    ]) {
      expect(FILTERED_ENV_VARS.has(name)).toBe(true)
    }
  })
})

describe('sessionEnvironment', () => {
  it('filters secrets and rejects malformed names', () => {
    expect(sessionEnvironment({ AICO_OWNER: 'aico', SECRET_KEY: 'x' })).toEqual({
      AICO_OWNER: 'aico',
    })
    expect(() => sessionEnvironment({ 'BAD-NAME': 'x' })).toThrow()
  })
})

describe('cleanEnvArgv', () => {
  it('starts from an empty environment in a stable order', () => {
    expect(cleanEnvArgv({ B: '2', A: '1' })).toEqual(['/usr/bin/env', '-i', 'A=1', 'B=2'])
  })
})

describe('parseGraphicalEnvironment', () => {
  it('keeps only the desktop session variables', () => {
    const text = [
      'HOME=/home/u',
      'DISPLAY=:1',
      'XAUTHORITY=/run/user/1000/gdm/Xauthority',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      "WAYLAND_DISPLAY=$'odd\\nvalue'",
      'OPENAI_API_KEY=secret',
      '',
    ].join('\n')
    expect(parseGraphicalEnvironment(text)).toEqual({
      DISPLAY: ':1',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    })
  })
})
