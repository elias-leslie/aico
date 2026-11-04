// Enrollment crosses the owner's existing Needs-you surface. Only public key
// material is displayed or copied; root pins it after the exact ask is approved.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { runExec } from '@aico/fleet/exec'
import { enrollmentCode, fingerprint, loadIdentity, machineName } from '@aico/fleet/identity'
import {
  DEFAULT_UPDATE_PINS,
  RELEASE_FILES,
  readUpdateKeys,
  SIGNED_RELEASE,
  signRelease,
  stageRelease,
} from '@aico/fleet/releases'
import {
  forgetLogin,
  loadToolSecrets,
  pushToolLogins,
  receiveLogins,
  secretsDir,
  toolEnvironment,
} from '@aico/fleet/secrets'
import { readSettings } from '@aico/fleet/settings'
import { approvePin, type Pin, parsePins } from '@aico/fleet/trust'
import { callSocket } from './client'
import { isInstanceName, type TetherPaths } from './config'
import { shellQuote } from './hub/host-admin'
import { pushRelease, updateLine } from './hub/update'

async function input(limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk)
    if (size > limit) throw new Error('Fleet delivery exceeds its size limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

export function enrollmentQuestion(pin: Pin): string {
  return `Allow ${pin.name} to join Aico as ${pin.role} with key ${fingerprint(pin.publicKey)} (code ${enrollmentCode(pin.name, pin.publicKey)})?`
}

export function enrollmentBody(pin: Pin): string {
  return `Role: ${pin.role}. Compare this machine’s code and full key fingerprint before approving.\nPublic key: ${pin.publicKey}`
}

export function approvedEnrollment(pin: Pin, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const ask = value as Record<string, unknown>
  return (
    ask.state === 'answered' &&
    ask.answer === 'Approve' &&
    ask.question === enrollmentQuestion(pin) &&
    ask.body === enrollmentBody(pin)
  )
}

export async function runFleet(
  args: string[],
  paths: TetherPaths,
  io: { out(text: string): void; err(text: string): void },
): Promise<number> {
  const [command, ...rest] = args
  if (command === 'receive-logins') {
    for (const name of receiveLogins(await input(1024 * 1024))) io.out(`${name} written`)
    return 0
  }
  if (command === 'forget-login') {
    forgetLogin(rest[0] || '')
    io.out('Login removed')
    return 0
  }
  if (command === 'tool') {
    const [tool, separator, executable, ...argv] = rest
    if (!tool || separator !== '--' || !executable)
      throw new Error('Usage: tether fleet tool TOOL -- COMMAND [ARGS]')
    return new Promise((resolve) => {
      const child = spawn(executable, argv, { stdio: 'inherit', env: toolEnvironment(tool) })
      child.once('error', () => resolve(1))
      child.once('close', (code) => resolve(code ?? 1))
    })
  }
  if (command === 'login-status') {
    const entries = loadToolSecrets()
    io.out(
      JSON.stringify({
        host: machineName(hostname()),
        agent_hub: 'Aico secrets folder',
        tools: [...new Set(entries.map((entry) => entry.tool))].map((tool) => ({
          tool,
          state: entries
            .filter((entry) => entry.tool === tool)
            .every((entry) => existsSync(join(secretsDir(), entry.file)))
            ? 'signed_in'
            : 'needs_sign_in',
          source: 'Aico secrets folder',
          credentials: [],
        })),
      }),
    )
    return 0
  }
  if (command === 'push-logins') {
    const settings = readSettings(process.env, paths.socket)
    if (!settings || !rest[0]) throw new Error('Usage: tether fleet push-logins MACHINE [TOOL]')
    for (const name of await pushToolLogins(settings, rest[0], rest[1])) io.out(`${name} written`)
    return 0
  }
  if (command === 'sign-update') {
    const release = rest[0]
    if (!release) throw new Error('Usage: tether fleet sign-update RELEASE')
    const envelope = signRelease(release, join(secretsDir(), 'update-signing-key'))
    writeFileSync(join(release, SIGNED_RELEASE), envelope, { mode: 0o600 })
    io.out('Release signed')
    return 0
  }
  if (command === 'push-update') {
    const [name, release, instance = 'default'] = rest
    const settings = readSettings(process.env, paths.socket)
    if (!settings || !name || !release)
      throw new Error('Usage: tether fleet push-update MACHINE RELEASE [INSTANCE]')
    const result = await pushRelease(release, {
      entry: {
        name,
        socket: `/run/user/${process.getuid?.() ?? 1000}/tether/${instance}/control.sock`,
        stateDir: null,
      } as import('@aico/fleet/hosts').HostEntry,
      control: join(settings.peerRoot, name, 'exec.sock'),
      instance,
    })
    io.out(result.stdout || result.output)
    return result.code ?? 1
  }
  if (command === 'receive-update') {
    const [instance, socket, stateDir] = rest
    if (!instance || !isInstanceName(instance) || !socket?.startsWith('/'))
      throw new Error('Invalid update target')
    const settings = readSettings(process.env, paths.socket)
    if (!settings) throw new Error('Fleet is not configured')
    const stage = stageRelease(
      await input(64 * 1024 * 1024),
      join(settings.stateDir, 'updates'),
      readUpdateKeys(settings.updatePins || DEFAULT_UPDATE_PINS),
    )
    const archive = join(stage, 'release.tar')
    const packed = spawnSync('tar', ['-cf', archive, ...RELEASE_FILES, SIGNED_RELEASE], {
      cwd: stage,
    })
    if (packed.status !== 0) throw new Error('Could not stage the signed release')
    const script = join(stage, 'install.sh')
    writeFileSync(script, updateLine(instance, socket, undefined, stateDir || null), {
      mode: 0o700,
    })
    const result = spawnSync(
      'systemd-run',
      [
        '--user',
        '--no-ask-password',
        '--collect',
        '--quiet',
        '--property=Type=exec',
        'bash',
        '-c',
        `bash ${shellQuote(script)} < ${shellQuote(archive)}`,
      ],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) throw new Error('Could not start the signed update')
    io.out('Signed update accepted')
    return 0
  }
  if (!command || command === 'help' || command === '--help') {
    io.out(
      'Usage: tether fleet identity ROLE | enroll PUBLIC_FILE | approve PUBLIC_FILE ASK_ID ALLOWLIST | exec SOCKET -- COMMAND [ARGS]',
    )
    io.out(
      'Also: push-logins MACHINE [TOOL] | login-status | tool TOOL -- COMMAND [ARGS] | sign-update RELEASE | push-update MACHINE RELEASE [INSTANCE]',
    )
    return command ? 0 : 2
  }
  if (command === 'exec') {
    const at = rest.indexOf('--')
    if (at !== 1 || !rest[0] || !rest[2])
      throw new Error('Usage: tether fleet exec SOCKET -- COMMAND [ARGS]')
    return runExec(rest[0], rest.slice(2))
  }
  if (command === 'identity') {
    const role = rest[0]
    if (role !== 'full' && role !== 'worker')
      throw new Error('Usage: tether fleet identity full|worker')
    const dir =
      process.env.AICO_DATA_DIR ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'aico')
    const identity = loadIdentity(dir, machineName(hostname()))
    io.out(
      JSON.stringify({
        name: identity.name,
        role,
        publicKey: identity.publicKey,
        code: enrollmentCode(identity.name, identity.publicKey),
      }),
    )
    return 0
  }
  if (command === 'enroll' || command === 'approve') {
    const path = rest[0]
    if (!path) throw new Error('Give the public enrollment file')
    const [pin] = parsePins([JSON.parse(readFileSync(path, 'utf8'))])
    if (!pin) throw new Error('Missing public enrollment identity')
    if (command === 'enroll') {
      const answer = await callSocket(paths.socket, 'POST', '/v1/asks', {
        question: enrollmentQuestion(pin),
        options: ['Approve', 'Reject'],
        recommended: 0,
        body: enrollmentBody(pin),
        requester: 'fleet-enrollment',
      })
      io.out(JSON.stringify(answer.body))
      return answer.status === 201 || answer.status === 200 ? 0 : 1
    }
    const askId = rest[1]
    const allowlist = rest[2]
    if (!askId || !allowlist)
      throw new Error('Usage: tether fleet approve PUBLIC_FILE ASK_ID ALLOWLIST')
    const answer = await callSocket(paths.socket, 'GET', `/v1/asks/${encodeURIComponent(askId)}`)
    if (
      answer.status !== 200 ||
      (answer.body as { id?: string })?.id !== askId ||
      !approvedEnrollment(pin, answer.body)
    )
      throw new Error('The owner has not approved this exact machine, role and key')
    approvePin(allowlist, pin, enrollmentCode(pin.name, pin.publicKey), askId)
    io.out(`${pin.name} is approved.`)
    return 0
  }
  io.err(
    'Usage: tether fleet identity ROLE | enroll PUBLIC_FILE | approve PUBLIC_FILE ASK_ID ALLOWLIST | exec SOCKET -- COMMAND [ARGS]',
  )
  return 2
}
