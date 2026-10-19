import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePaths } from './config'
import { checkPanePolicy, checkSocket } from './doctor'
import { listenPrivateSocket } from './http'
import { tmuxConf } from './lifecycle/tmux'
import {
  bindPanePolicy,
  currentPaneRefusal,
  detectSharedMode,
  type PolicyLocation,
  paneUidRefusal,
  policyLocationIn,
  readAllowFlag,
  readPanePolicy,
} from './pane-policy'
import { waitForDesktop } from './reboot'

const uid = process.getuid?.() ?? 1000
let root: string
let etc: string
let run: string
let location: PolicyLocation

function writePolicy(body: unknown, mode = 0o644): void {
  writeFileSync(location.policyFile, JSON.stringify(body), { mode })
  chmodSync(location.policyFile, mode)
}
function writeFlag(text: string, mode = 0o644): void {
  writeFileSync(location.allowFile, text, { mode })
  chmodSync(location.allowFile, mode)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tether-policy-'))
  etc = join(root, 'etc')
  run = join(root, 'run')
  mkdirSync(etc, { mode: 0o755 })
  mkdirSync(run, { mode: 0o755 })
  chmodSync(etc, 0o755)
  // The test user stands in for root: the files must belong to trustedUid.
  location = policyLocationIn(etc, run, uid)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  bindPanePolicy('default', policyLocationIn('/nonexistent/tether-policy', '/nonexistent/x', 0))
})

describe('policy trust', () => {
  it('treats a missing policy as no policy', () => {
    expect(readPanePolicy(location).state).toBe('absent')
    expect(paneUidRefusal(uid, 'default', location)).toBeNull()
    expect(detectSharedMode(uid, location, 'agent')).toBeNull()
  })

  it('reads a root-owned regular file', () => {
    writePolicy({ refuse_pane_uids: [1000], attach: { agent: ['kasadis'] } })
    const policy = readPanePolicy(location)
    expect(policy.state).toBe('ok')
    expect(policy.refuseUids).toEqual([1000])
    expect(policy.attach).toEqual({ agent: ['kasadis'] })
  })

  it('ignores a policy owned by someone else', () => {
    writePolicy({ refuse_pane_uids: [uid] })
    expect(readPanePolicy({ ...location, trustedUid: uid + 1 }).state).toBe('untrusted')
    expect(paneUidRefusal(uid, 'default', { ...location, trustedUid: uid + 1 })).toBeNull()
  })

  it('ignores a group- or other-writable file or directory', () => {
    writePolicy({ refuse_pane_uids: [uid] }, 0o664)
    expect(readPanePolicy(location).state).toBe('untrusted')
    writePolicy({ refuse_pane_uids: [uid] }, 0o646)
    expect(readPanePolicy(location).state).toBe('untrusted')
    writePolicy({ refuse_pane_uids: [uid] })
    chmodSync(etc, 0o775)
    expect(readPanePolicy(location).state).toBe('untrusted')
  })

  it('does not follow symlinks', () => {
    const real = join(root, 'real.json')
    writeFileSync(real, JSON.stringify({ refuse_pane_uids: [uid] }), { mode: 0o644 })
    symlinkSync(real, location.policyFile)
    expect(readPanePolicy(location).state).toBe('untrusted')
    rmSync(location.policyFile)
    mkdirSync(location.policyFile)
    expect(readPanePolicy(location).state).toBe('untrusted')
  })

  it('rejects a malformed policy', () => {
    writePolicy({ refuse_pane_uids: 'all' })
    expect(readPanePolicy(location).state).toBe('invalid')
    writePolicy({ attach: { agent: [1] } })
    expect(readPanePolicy(location).state).toBe('invalid')
  })
})

describe('pane uid refusal', () => {
  it('refuses a listed uid unless the instance is in the flag', () => {
    writePolicy({ refuse_pane_uids: [uid] })
    expect(paneUidRefusal(uid, 'default', location)).toContain('may not launch panes')
    expect(paneUidRefusal(uid + 1, 'default', location)).toBeNull()
    writeFlag('# still allowed\ndefault\n\nother\n')
    expect(readAllowFlag(location).instances).toEqual(['default', 'other'])
    expect(paneUidRefusal(uid, 'default', location)).toBeNull()
    expect(paneUidRefusal(uid, 'b5probe', location)).not.toBeNull()
  })

  it('ignores an untrusted flag and re-reads files on every launch', () => {
    writePolicy({ refuse_pane_uids: [uid] })
    writeFlag('default\n', 0o666)
    expect(readAllowFlag(location).state).toBe('untrusted')
    bindPanePolicy('default', location)
    expect(currentPaneRefusal()).not.toBeNull()
    writeFlag('default\n')
    expect(currentPaneRefusal()).toBeNull()
    rmSync(location.allowFile)
    expect(currentPaneRefusal()).not.toBeNull()
    rmSync(location.policyFile)
    expect(currentPaneRefusal()).toBeNull()
  })

  it('shows the state in doctor', () => {
    expect(checkPanePolicy(uid, 'default', location, false).status).toBe('ok')
    writePolicy({ refuse_pane_uids: [uid] })
    const refused = checkPanePolicy(uid, 'default', location, false)
    expect(refused.status).toBe('warn')
    expect(refused.detail).toContain('pane_uid_refused')
    writeFlag('default\n')
    const allowed = checkPanePolicy(uid, 'default', location, false)
    expect(allowed.status).toBe('ok')
    expect(allowed.detail).toContain('still allowed')
  })
})

describe('shared mode', () => {
  const env = { HOME: '/home/agent' }

  it('needs the policy, an attach list for me, and my own /run/tether/<me>', () => {
    expect(detectSharedMode(uid, location, 'agent')).toBeNull()
    writePolicy({ refuse_pane_uids: [1000], attach: { agent: ['kasadis'] } })
    expect(detectSharedMode(uid, location, 'agent')).toBeNull() // no run dir yet
    mkdirSync(join(run, 'agent'))
    expect(detectSharedMode(uid, location, 'agent')?.attachUsers).toEqual(['kasadis'])
    expect(detectSharedMode(uid + 1, location, 'agent')).toBeNull() // not owned by that uid
    expect(detectSharedMode(uid, location, 'someone')).toBeNull() // no attach list for them
  })

  it('moves the runtime and tmux dirs under /run/tether/<me>/<instance>', () => {
    writePolicy({ attach: { agent: ['kasadis'] } })
    mkdirSync(join(run, 'agent'))
    const paths = resolvePaths({
      instance: 'default',
      env,
      uid,
      policy: location,
      username: 'agent',
    })
    expect(paths.shared?.attachUsers).toEqual(['kasadis'])
    expect(paths.runtimeDir).toBe(join(run, 'agent', 'default'))
    expect(paths.socket).toBe(join(run, 'agent', 'default', 'control.sock'))
    const id = 'a'.repeat(32)
    expect(paths.tmuxDir).toBe(join(run, 'agent', 'default', 'tmux'))
    // The attach socket layout a client validates against.
    const sock = join(paths.tmuxDir, id, 'server.sock').replace(run, '/run/tether')
    expect(sock).toMatch(/^\/run\/tether\/[a-z]+\/default\/tmux\/[0-9a-f]{32}\/server\.sock$/)
  })

  it('leaves paths unchanged without a policy', () => {
    const paths = resolvePaths({
      env: { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' },
      uid,
      policy: location,
    })
    expect(paths.shared).toBeNull()
    expect(paths.socket).toBe('/run/user/1000/tether/default/control.sock')
    expect(paths.tmuxDir).toBe('/home/u/.local/state/tether/default/tmux')
  })

  it('adds server-access for each attach user to the tmux config only in shared mode', () => {
    expect(tmuxConf()).not.toContain('server-access')
    expect(tmuxConf(['kasadis', 'bob'])).toContain(
      'server-access -a kasadis\nserver-access -a bob\n',
    )
  })

  it('binds the control socket 0660 in a 0750 directory, still owned by me', async () => {
    const dir = join(root, 'agent', 'default')
    mkdirSync(join(root, 'agent'), { mode: 0o755 })
    const socket = join(dir, 'control.sock')
    const server = createServer()
    await listenPrivateSocket(server, socket, { shared: true })
    const { statSync } = await import('node:fs')
    expect(statSync(dir).mode & 0o5777).toBe(0o750)
    expect(statSync(socket).mode & 0o777).toBe(0o660)
    const pathMode = (path: string) => {
      const s = statSync(path)
      return {
        exists: true,
        isSocket: s.isSocket(),
        isDirectory: s.isDirectory(),
        mode: s.mode,
        uid: s.uid,
      }
    }
    expect(checkSocket(pathMode(dir), pathMode(socket), uid, true).status).toBe('ok')
    expect(checkSocket(pathMode(dir), pathMode(socket), uid, false).status).toBe('fail')
    await new Promise((resolve) => server.close(resolve))
  })

  it('keeps the ownership check in shared mode', async () => {
    // /usr is a root-owned directory: shared mode relaxes permissions, not who must own the directory.
    await expect(
      listenPrivateSocket(createServer(), '/usr/tether-test.sock', { shared: true }),
    ).rejects.toThrow('not a directory owned by this user')
  })

  it('keeps the private socket 0700/0600 by default', async () => {
    const dir = join(root, 'priv')
    const socket = join(dir, 'control.sock')
    const server = createServer()
    await listenPrivateSocket(server, socket)
    const { statSync } = await import('node:fs')
    expect(statSync(dir).mode & 0o7777).toBe(0o700)
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    await new Promise((resolve) => server.close(resolve))
  })
})

describe('headless restore', () => {
  it('skips the desktop wait when headless and waits otherwise', async () => {
    let now = 0
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
      now += ms
    }
    await waitForDesktop({ headless: true, desktopReady: () => false, now: () => now, sleep })
    expect(sleeps).toEqual([])
    await waitForDesktop({ headless: false, desktopReady: () => false, now: () => now, sleep })
    expect(sleeps.length).toBe(60) // five minutes in 5 s steps
    sleeps.length = 0
    await waitForDesktop({ headless: false, desktopReady: () => true, now: () => now, sleep })
    expect(sleeps).toEqual([])
  })
})
