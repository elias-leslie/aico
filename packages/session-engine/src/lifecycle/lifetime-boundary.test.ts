import { describe, expect, it } from 'vitest'
import { resolvePaths } from '../paths'
import { configureEngine } from './engine'
import {
  type ContainerBoundaryProbe,
  type DurabilityProbes,
  parseLifetimeBoundary,
  unifiedCgroupPath,
  verifyDurableUserManager,
} from './lifetime-boundary'

const UID = 1000
const TETHER_CGROUP = `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/app-tether.slice/tether@default.service\n`

function container(overrides: Partial<ContainerBoundaryProbe> = {}): ContainerBoundaryProbe {
  return {
    uid: UID,
    containerEnvFile: () => true,
    systemdContainer: () => null,
    userManagerState: () => 'running\n',
    ownCgroup: () => TETHER_CGROUP,
    ...overrides,
  }
}

function probes(
  overrides: { linger?: string | null; container?: Partial<ContainerBoundaryProbe> } = {},
): DurabilityProbes & { lingerCalls: number } {
  const result = {
    lingerCalls: 0,
    linger: () => {
      result.lingerCalls += 1
      return overrides.linger === undefined ? 'yes\n' : overrides.linger
    },
    container: container(overrides.container),
  }
  return result
}

describe('TETHER_LIFETIME_BOUNDARY', () => {
  it('unset or empty keeps logind; container is the only other value', () => {
    expect(parseLifetimeBoundary(undefined)).toBe('logind')
    expect(parseLifetimeBoundary('')).toBe('logind')
    expect(parseLifetimeBoundary('container')).toBe('container')
    for (const value of ['logind', 'Container', 'container ', 'off', 'host']) {
      expect(() => parseLifetimeBoundary(value)).toThrow(
        /TETHER_LIFETIME_BOUNDARY=.* is not supported: set it to "container" or leave it unset/,
      )
    }
  })

  it('an unsupported value refuses engine configuration (daemon startup)', () => {
    const paths = resolvePaths({
      instance: 'boundarytest',
      env: {
        HOME: '/nonexistent',
        TETHER_STATE_DIR: '/nonexistent/s',
        TETHER_RUNTIME_DIR: '/nonexistent/r',
      },
      uid: UID,
    })
    const base = { paths, events: null, projectRoot: () => null }
    expect(() =>
      configureEngine({ ...base, env: { TETHER_LIFETIME_BOUNDARY: 'containers' } }),
    ).toThrow(/TETHER_LIFETIME_BOUNDARY="containers" is not supported/)
    expect(() =>
      configureEngine({ ...base, env: { TETHER_LIFETIME_BOUNDARY: 'container' } }),
    ).not.toThrow()
    expect(() => configureEngine({ ...base, env: {} })).not.toThrow()
  })
})

describe('default logind boundary', () => {
  it('requires Linger=yes and never looks at the container', () => {
    const containerCalls: string[] = []
    const watched = probes({
      container: {
        containerEnvFile: () => {
          containerCalls.push('marker')
          return true
        },
      },
    })
    expect(verifyDurableUserManager('logind', watched)).toEqual({ durable: true })
    expect(verifyDurableUserManager('logind', probes({ linger: 'no' }))).toEqual({
      durable: false,
      reason: 'user linger is not enabled',
    })
    expect(verifyDurableUserManager('logind', probes({ linger: null })).durable).toBe(false)
    expect(containerCalls).toEqual([])
  })
})

describe('container boundary', () => {
  it('accepts a container with its own running user manager and Tether in it', () => {
    const p = probes({ linger: 'no' })
    expect(verifyDurableUserManager('container', p)).toEqual({ durable: true })
    expect(p.lingerCalls).toBe(0)
  })

  it('accepts systemd container= in place of /run/.containerenv', () => {
    const p = probes({
      container: { containerEnvFile: () => false, systemdContainer: () => 'podman\n' },
    })
    expect(verifyDurableUserManager('container', p)).toEqual({ durable: true })
  })

  it('accepts manager states that are up, including degraded', () => {
    for (const state of ['initializing', 'starting', 'degraded', 'maintenance']) {
      const p = probes({ container: { userManagerState: () => `${state}\n` } })
      expect(verifyDurableUserManager('container', p).durable).toBe(true)
    }
  })

  it('refuses outside a container', () => {
    const p = probes({ container: { containerEnvFile: () => false, systemdContainer: () => '  ' } })
    expect(verifyDurableUserManager('container', p)).toEqual({
      durable: false,
      reason: 'not running in a container',
    })
    expect(p.lingerCalls).toBe(0)
  })

  it('refuses an offline, unknown or unreachable user manager', () => {
    for (const [state, shown] of [
      ['offline\n', 'offline'],
      ['unknown\n', 'unknown'],
      ['', 'no answer'],
      [null, 'no answer'],
      ['Failed to connect to bus\n', 'Failed to connect to bus'],
    ] as const) {
      const verdict = verifyDurableUserManager(
        'container',
        probes({ container: { userManagerState: () => state } }),
      )
      expect(verdict).toEqual({
        durable: false,
        reason: `the container's user manager is not running (state: ${shown})`,
      })
    }
  })

  it('refuses a Tether cgroup outside its UID user manager', () => {
    const outside = [
      '0::/system.slice/tether.service\n',
      `0::/user.slice/user-${UID}.slice/session-3.scope\n`,
      // Another UID's manager, and a prefix that only looks like this UID's.
      '0::/user.slice/user-1001.slice/user@1001.service/app.slice/tether.service\n',
      `0::/user.slice/user-${UID}0.slice/user@${UID}0.service/app.slice/tether.service\n`,
      `0::/user.slice/user-${UID}.slice/user@${UID}.service\n`,
      '12:pids:/user.slice\n',
      null,
    ]
    for (const text of outside) {
      const verdict = verifyDurableUserManager(
        'container',
        probes({ container: { ownCgroup: () => text } }),
      )
      expect(verdict.durable).toBe(false)
      if (!verdict.durable)
        expect(verdict.reason).toMatch(/^Tether's cgroup .* is not under \/user\.slice/)
    }
  })

  it('checks the cgroup against the process UID, not another', () => {
    const p = probes({ container: { uid: 0 } })
    const verdict = verifyDurableUserManager('container', p)
    expect(verdict).toEqual({
      durable: false,
      reason: `Tether's cgroup /user.slice/user-${UID}.slice/user@${UID}.service/app.slice/app-tether.slice/tether@default.service is not under /user.slice/user-0.slice/user@0.service/`,
    })
  })

  it('reads the unified cgroup line only', () => {
    expect(unifiedCgroupPath(`1:name=systemd:/x\n${TETHER_CGROUP}`)).toBe(
      `/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/app-tether.slice/tether@default.service`,
    )
    expect(unifiedCgroupPath('0::\n')).toBeNull()
  })
})
