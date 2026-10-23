import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

function identity(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'aico-web-config-'))
  const file = join(dir, 'project.identity.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

const ID = identity({
  runtime: { frontend_port: 4321 },
  hosts: { browser_frontend: 'App.Example' },
})

describe('loadConfig', () => {
  it('takes the port and public host from the identity file', () => {
    const config = loadConfig({ HOME: '/home/u' }, ID)
    expect(config.port).toBe(4321)
    expect(config.host).toBe('127.0.0.1')
    expect(config.allowedHostnames).toEqual(['localhost', '127.0.0.1', 'app.example'])
    expect(config.allowedOrigins).toEqual([
      'http://localhost:4321',
      'http://127.0.0.1:4321',
      'https://app.example',
    ])
    expect(config.dbPath).toBe('/home/u/.local/state/aico/web.db')
    expect(config.importDbPath).toBe('/home/u/.local/state/a-term/a-term.db')
  })

  it('lets the environment override port, origins, paths and Agent Hub', () => {
    const config = loadConfig(
      {
        HOME: '/home/u',
        XDG_STATE_HOME: '/state',
        AICO_WEB_PORT: '5555',
        AICO_WEB_ALLOWED_ORIGINS: 'http://127.0.0.1:6000, https://x.example',
        AICO_WEB_IMPORT_DB: '/old.db',
        NEXT_PUBLIC_AGENT_HUB_URL: 'http://hub.local',
        AGENT_HUB_CLIENT_ID: ' client ',
      },
      ID,
    )
    expect(config.port).toBe(5555)
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:6000', 'https://x.example'])
    expect(config.dbPath).toBe('/state/aico/web.db')
    expect(config.importDbPath).toBe('/old.db')
    expect(config.agentHubUrl).toBe('http://hub.local')
    expect(config.agentHubClientId).toBe('client')
  })

  it('refuses a non-loopback bind and a missing port', () => {
    expect(() => loadConfig({ AICO_WEB_HOST: '0.0.0.0' }, ID)).toThrow(/loopback/)
    expect(() => loadConfig({}, identity({}))).toThrow(/No port/)
  })
})
