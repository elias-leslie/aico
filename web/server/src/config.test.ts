import { mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
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
  runtime: { backend_port: 4321 },
  hosts: { browser_frontend: 'App.Example' },
})

describe('loadConfig', () => {
  it('puts the sync socket in the runtime directory and reads the sync settings', () => {
    const config = loadConfig({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/7' }, ID)
    expect(config.sync).toMatchObject({
      socket: '/run/user/7/aico/sync.sock',
      intervalMs: 60_000,
      blobGraceMs: 7 * 86_400_000,
      hostsFile: '/home/u/.config/tether/hosts.json',
    })
    const set = loadConfig(
      {
        HOME: '/home/u',
        AICO_SYNC_SOCKET: '/tmp/s.sock',
        AICO_SYNC_INTERVAL_SECONDS: '5',
        TETHER_HOSTS_FILE: '/tmp/h.json',
      },
      ID,
    )
    expect(set.sync).toMatchObject({
      socket: '/tmp/s.sock',
      intervalMs: 5_000,
      hostsFile: '/tmp/h.json',
    })
  })

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
  })

  it('lets the environment override port, origins, paths and Agent Hub', () => {
    const config = loadConfig(
      {
        HOME: '/home/u',
        XDG_STATE_HOME: '/state',
        AICO_WEB_PORT: '5555',
        AICO_WEB_ALLOWED_ORIGINS: 'http://127.0.0.1:6000, https://x.example',
        NEXT_PUBLIC_AGENT_HUB_URL: 'http://hub.local',
        AGENT_HUB_CLIENT_ID: ' client ',
      },
      ID,
    )
    expect(config.port).toBe(5555)
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:6000', 'https://x.example'])
    expect(config.dbPath).toBe('/state/aico/web.db')
    expect(config.agentHubUrl).toBe('http://hub.local')
    expect(config.agentHubClientId).toBe('client')
  })

  it('refuses a non-loopback bind and a missing port', () => {
    expect(() => loadConfig({ AICO_WEB_HOST: '0.0.0.0' }, ID)).toThrow(/loopback/)
    expect(() => loadConfig({}, identity({}))).toThrow(/No port/)
  })
})

describe('loadConfig: uploads, shares and maintenance', () => {
  it('defaults to the Python backend’s settings', () => {
    const config = loadConfig({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/7' }, ID)
    expect(config.uploads).toEqual({
      dir: '/home/u/aico-uploads',
      remoteDir: '~/.cache/aico/uploads',
      maxBytes: 10 * 1024 * 1024,
      maxAgeMs: 86_400_000,
    })
    expect(config.maintenance).toEqual({ enabled: true, intervalMs: 900_000, emptyPaneDays: 7 })
  })

  it('reads the same environment names as the Python backend', () => {
    const config = loadConfig(
      {
        HOME: '/home/u',
        UPLOAD_DIR: '~/drops',
        AICO_REMOTE_UPLOAD_DIR: '/srv/drops',
        MAX_FILE_SIZE_MB: '2',
        UPLOAD_MAX_AGE_SECONDS: '60',
        MAINTENANCE_ENABLED: 'false',
        MAINTENANCE_INTERVAL_SECONDS: '30',
        MAINTENANCE_SESSION_PURGE_DAYS: '3',
      },
      identity({ runtime: { backend_port: 1 }, artifacts: { upload_dir_name: 'ignored' } }),
    )
    expect(config.uploads).toEqual({
      dir: '/home/u/drops',
      remoteDir: '/srv/drops',
      maxBytes: 2 * 1024 * 1024,
      maxAgeMs: 60_000,
    })
    expect(config.maintenance).toEqual({ enabled: false, intervalMs: 30_000, emptyPaneDays: 3 })
  })

  it('keeps captures beside web.db, 25 MB and 20 files by default', () => {
    const config = loadConfig({ HOME: '/home/u' }, ID)
    expect(config.dataDir).toBe('/home/u/.local/state/aico')
    expect(config.captures).toEqual({ maxBytes: 25 * 1024 * 1024, maxFiles: 20 })
    expect(config.hostName).toBe(hostname().toLowerCase())
  })

  it('reads the capture folder, limits and host name from the environment', () => {
    const config = loadConfig(
      {
        HOME: '/home/u',
        AICO_DATA_DIR: '/srv/aico-data',
        AICO_CAPTURE_MAX_MB: '5',
        AICO_CAPTURE_MAX_FILES: '4',
        AICO_HOST_NAME: ' Gem ',
      },
      ID,
    )
    expect(config.dataDir).toBe('/srv/aico-data')
    expect(config.captures).toEqual({ maxBytes: 5 * 1024 * 1024, maxFiles: 4 })
    expect(config.hostName).toBe('gem')
    // Without AICO_DATA_DIR it follows web.db.
    expect(loadConfig({ AICO_WEB_DB: '/tmp/x/web.db' }, ID).dataDir).toBe('/tmp/x')
  })

  it('reads Nightshift on its own loopback address unless told otherwise', () => {
    expect(loadConfig({}, ID).nightshiftUrl).toBe('http://127.0.0.1:3020')
    expect(loadConfig({ AICO_NIGHTSHIFT_URL: 'http://127.0.0.1:4000' }, ID).nightshiftUrl).toBe(
      'http://127.0.0.1:4000',
    )
    expect(loadConfig({ AICO_NIGHTSHIFT_URL: 'off' }, ID).nightshiftUrl).toBeNull()
  })

  it("trusts agent shares only from the owner's default Tether", () => {
    const env = { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/7' }
    expect(loadConfig(env, ID).trustShows).toBe(true)
    expect(loadConfig({ ...env, TETHER_INSTANCE: 'dev' }, ID).trustShows).toBe(false)
    expect(loadConfig({ ...env, TETHER_SOCKET: '/tmp/third.sock' }, ID).trustShows).toBe(false)
  })
})
