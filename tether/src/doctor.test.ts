import { describe, expect, it } from 'vitest'
import {
  checkCgroup,
  checkEnabledInstances,
  checkLinger,
  checkMemoryGuard,
  checkNode,
  checkSocket,
  checkSystemd,
  parseSystemdVersion,
} from './doctor'

describe('doctor checks', () => {
  it('warns when an instance besides default starts at boot', () => {
    expect(checkEnabledInstances(['default'])).toMatchObject({ status: 'ok' })
    expect(checkEnabledInstances([])).toMatchObject({ status: 'ok' })
    const extra = checkEnabledInstances(['dev', 'default'])
    expect(extra.status).toBe('warn')
    expect(extra.detail).toContain('systemctl --user disable tether@dev.service')
  })

  it('requires linger, systemd 254+, cgroup v2 and node 22.13+', () => {
    expect(checkLinger('yes').status).toBe('ok')
    expect(checkLinger('no').status).toBe('fail')
    expect(parseSystemdVersion('systemd 255 (255.4-1ubuntu8.17)\n+PAM')).toBe(255)
    expect(checkSystemd('systemd 253 (253)').status).toBe('fail')
    expect(checkSystemd('systemd 254 (254)').status).toBe('ok')
    expect(checkSystemd(null).status).toBe('fail')
    expect(checkCgroup(true, '0::/user.slice/x\n').status).toBe('ok')
    expect(checkCgroup(true, '12:cpu:/x\n0::/x\n').status).toBe('fail')
    expect(checkNode('v22.12.0', true).status).toBe('fail')
    expect(checkNode('v22.13.0', true).status).toBe('ok')
    expect(checkNode('v24.14.1', false).status).toBe('fail')
  })

  it('checks socket ownership and modes', () => {
    const dir = { exists: true, isDirectory: true, mode: 0o40700, uid: 1000 }
    const socket = { exists: true, isSocket: true, mode: 0o140600, uid: 1000 }
    expect(checkSocket(dir, socket, 1000).status).toBe('ok')
    expect(checkSocket(dir, { exists: false }, 1000).status).toBe('warn')
    expect(checkSocket({ ...dir, mode: 0o40755 }, socket, 1000).status).toBe('fail')
    expect(checkSocket(dir, { ...socket, mode: 0o140666 }, 1000).status).toBe('fail')
    expect(checkSocket(dir, socket, 1001).status).toBe('fail')
  })

  it('looks for the tmux-spawn memory guard', () => {
    expect(checkMemoryGuard(['[Scope]\nMemoryMax=16G\nMemorySwapMax=3G\n'])).toMatchObject({
      status: 'ok',
      detail: 'tmux-spawn-.scope MemoryMax=16G MemorySwapMax=3G',
    })
    expect(checkMemoryGuard([]).status).toBe('warn')
    const throttled = checkMemoryGuard(['[Scope]\nMemoryHigh=6G\nMemoryMax=8G\n'])
    expect(throttled.status).toBe('warn')
    expect(throttled.detail).toContain('fixed MemoryHigh=6G')
    expect(throttled.detail).toContain('no MemorySwapMax')
    // A later drop-in that lifts MemoryHigh wins.
    expect(
      checkMemoryGuard(['MemoryHigh=6G\nMemoryMax=8G\n', 'MemoryHigh=infinity\nMemorySwapMax=3G\n'])
        .status,
    ).toBe('ok')
  })
})
