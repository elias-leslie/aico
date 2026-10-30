import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostsFilePath, loadHosts, parseHosts, peerDir } from './hosts'
import { LINK_BACKOFF_MAX_MS, linkArgv, linkBackoff, linkPaths } from './link'
import { kickArgv } from './wake'

const VALID = {
  name: 'agent-work',
  ssh: 'agent-work',
  socket: '/run/user/1000/tether/default/control.sock',
  forwards: ['8001', 8003],
  wake: ['st', 'vm', 'start', '200'],
  health: ['http://127.0.0.1:8001/health', 'http://127.0.0.1:8003/health'],
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
          sleep: null,
          status: null,
          statusOff: '\\bstopped\\b',
          health: ['http://127.0.0.1:8001/health', 'http://127.0.0.1:8003/health'],
          wakeTimeoutSec: 240,
          stateDir: null,
        },
      ],
      errors: [],
      readable: true,
      held: [],
    })
  })

  it('treats a missing file as no hosts and no error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-hosts-'))
    dirs.push(dir)
    expect(loadHosts(join(dir, 'hosts.json'))).toEqual({
      hosts: [],
      errors: [],
      readable: true,
      held: [],
    })
    writeFileSync(join(dir, 'hosts.json'), '{nope')
    expect(loadHosts(join(dir, 'hosts.json'))).toMatchObject({
      errors: ['hosts.json is not valid JSON'],
      readable: false,
    })
    writeFileSync(join(dir, 'hosts.json'), '{}')
    expect(loadHosts(join(dir, 'hosts.json')).readable).toBe(false)
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
    [{ ...VALID, sleep: ['st', ''] }, 'sleep must be a non-empty argv list'],
    [{ ...VALID, status: 'st vm status 200' }, 'status must be a non-empty argv list'],
    [{ ...VALID, statusOff: '(' }, 'statusOff must be a regular expression'],
    [{ ...VALID, stateDir: 'state' }, 'stateDir must be an absolute path'],
    [{ ...VALID, health: ['http://10.0.0.5:8001/health'] }, 'health must be a list'],
    [{ ...VALID, health: ['http://127.0.0.1:8001/$(id)'] }, 'health must be a list'],
    [{ ...VALID, wakeTimeoutSec: 5 }, 'wakeTimeoutSec must be'],
  ])('skips an invalid entry with its reason (%#)', (entry, reason) => {
    const { hosts, errors, held } = parseHosts(JSON.stringify([entry]))
    expect(hosts).toEqual([])
    expect(errors[0]).toContain(reason)
    expect(held).toEqual(/name must be/.test(reason) ? [] : ['agent-work'])
  })

  it('reads the power status command and what its output says for off', () => {
    const { hosts } = parseHosts(
      JSON.stringify([
        { ...VALID, status: ['st', 'vm', 'status', '200'], statusOff: 'state: (off|stopped)' },
      ]),
    )
    expect(hosts[0]).toMatchObject({
      status: ['st', 'vm', 'status', '200'],
      statusOff: 'state: (off|stopped)',
    })
  })

  it('keeps an entry with fields it does not know, and says which', () => {
    const { hosts, errors, held } = parseHosts(
      JSON.stringify([{ ...VALID, password: 'x', later: 1 }]),
    )
    expect(hosts.map((host) => host.name)).toEqual(['agent-work'])
    expect(errors).toEqual(['agent-work: ignoring unknown fields password, later'])
    expect(held).toEqual([])
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

  it('kicks only the link process, never its ssh (ssh exits on SIGUSR1)', () => {
    expect(kickArgv('agent-work')).toEqual([
      'systemctl',
      '--user',
      'kill',
      '--kill-whom=main',
      '-s',
      'USR1',
      'tether-link@agent-work.service',
    ])
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
      'ServerAliveInterval=5',
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
