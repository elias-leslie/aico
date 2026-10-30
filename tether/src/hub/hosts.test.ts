import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostsFilePath, loadHosts, parseHosts, peerDir } from './hosts'
import { LINK_BACKOFF_MAX_MS, linkArgv, linkBackoff, linkPaths } from './link'

const VALID = {
  name: 'agent-work',
  ssh: 'agent-work',
  socket: '/run/user/1000/tether/default/control.sock',
  forwards: ['8001', 8003],
  wake: ['st', 'vm', 'start', '200'],
}

describe('hosts registry', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('parses a valid entry into typed data', () => {
    expect(parseHosts(JSON.stringify([VALID]))).toEqual({
      hosts: [
        {
          name: 'agent-work',
          ssh: 'agent-work',
          socket: '/run/user/1000/tether/default/control.sock',
          forwards: [8001, 8003],
          wake: ['st', 'vm', 'start', '200'],
          stateDir: null,
        },
      ],
      errors: [],
    })
  })

  it('treats a missing file as no hosts and no error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-hosts-'))
    dirs.push(dir)
    expect(loadHosts(join(dir, 'hosts.json'))).toEqual({ hosts: [], errors: [] })
    writeFileSync(join(dir, 'hosts.json'), '{nope')
    expect(loadHosts(join(dir, 'hosts.json')).errors).toEqual(['hosts.json is not valid JSON'])
  })

  it.each([
    [{ ...VALID, ssh: '10.0.0.5' }, 'ssh must be an ssh Host alias'],
    [{ ...VALID, ssh: 'agent work' }, 'ssh must be an ssh Host alias'],
    [{ ...VALID, name: 'Agent_Work' }, 'name must be'],
    [{ ...VALID, name: 'local' }, 'name must be'],
    [{ ...VALID, socket: 'run/control.sock' }, 'socket must be an absolute path'],
    [{ ...VALID, socket: '/run/../etc/x.sock' }, 'socket must be an absolute path'],
    [{ ...VALID, forwards: ['80a'] }, 'forwards must be ports'],
    [{ ...VALID, forwards: [70_000] }, 'forwards must be ports'],
    [{ ...VALID, wake: [] }, 'wake must be a non-empty argv list'],
    [{ ...VALID, stateDir: 'state' }, 'stateDir must be an absolute path'],
    [{ ...VALID, password: 'x' }, 'unknown fields password'],
  ])('skips an invalid entry with its reason (%#)', (entry, reason) => {
    const { hosts, errors } = parseHosts(JSON.stringify([entry]))
    expect(hosts).toEqual([])
    expect(errors[0]).toContain(reason)
  })

  it('keeps the first of two entries with one name', () => {
    const { hosts, errors } = parseHosts(
      JSON.stringify([VALID, { ...VALID, ssh: 'other' }, { ...VALID, name: 'b' }]),
    )
    expect(hosts.map((host) => [host.name, host.ssh])).toEqual([
      ['agent-work', 'agent-work'],
      ['b', 'agent-work'],
    ])
    expect(errors).toEqual(['agent-work: duplicate name; the first entry is used'])
  })

  it('resolves the registry and peer paths from the environment', () => {
    expect(hostsFilePath({ HOME: '/home/u' })).toBe('/home/u/.config/tether/hosts.json')
    expect(hostsFilePath({ XDG_CONFIG_HOME: '/c', TETHER_HOSTS_FILE: '/t/h.json' })).toBe(
      '/t/h.json',
    )
    expect(peerDir({ XDG_RUNTIME_DIR: '/run/user/7' }, 7, 'vm')).toBe('/run/user/7/tether/peers/vm')
  })
})

describe('link', () => {
  it('builds one ssh master that forwards the control socket and the ports', () => {
    const host = parseHosts(JSON.stringify([VALID])).hosts[0]
    if (!host) throw new Error('no host')
    const paths = linkPaths('/run/user/1000/tether/peers/agent-work')
    expect(linkArgv(host, paths)).toEqual([
      '-N',
      '-T',
      '-M',
      '-S',
      '/run/user/1000/tether/peers/agent-work/ssh.ctl',
      '-o',
      'ControlPersist=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StreamLocalBindUnlink=yes',
      '-o',
      'StreamLocalBindMask=0177',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-L',
      '/run/user/1000/tether/peers/agent-work/control.sock:/run/user/1000/tether/default/control.sock',
      '-R',
      '127.0.0.1:8001:127.0.0.1:8001',
      '-R',
      '127.0.0.1:8003:127.0.0.1:8003',
      '--',
      'agent-work',
    ])
  })

  it('backs off with jitter up to a cap', () => {
    expect(linkBackoff(0, () => 0)).toBe(1_000)
    expect(linkBackoff(0, () => 1)).toBe(2_000)
    expect(linkBackoff(3, () => 0.5)).toBe(12_000)
    expect(linkBackoff(40, () => 1)).toBe(LINK_BACKOFF_MAX_MS)
    expect(linkBackoff(40, () => 0)).toBe(LINK_BACKOFF_MAX_MS / 2)
  })
})
