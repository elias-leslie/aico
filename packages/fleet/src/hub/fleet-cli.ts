// Enrollment crosses the owner's existing Needs-you surface. Only public key
// material is displayed or copied; root pins it after the exact ask is approved.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { runExec } from '../exec'
import { hostsFilePath, loadHosts } from '../hosts'
import { enrollmentCode, fingerprint, loadIdentity, machineName } from '../identity'
import {
  DEFAULT_UPDATE_PINS,
  readUpdateKeys,
  SIGNED_RELEASE,
  signRelease,
  verifyRelease,
} from '../releases'
import {
  forgetLogin,
  loadToolSecrets,
  pushToolLogins,
  receiveLogins,
  secretsDir,
  toolEnvironment,
} from '../secrets'
import { readSettings } from '../settings'
import { approvePin, type Pin, parsePins } from '../trust'
import type { HubPorts } from './types'
import { pushRelease, receiveUpdate, updateResult } from './update'

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

/** What `tether fleet` takes from the Tether that runs it. */
export interface FleetCliPorts extends HubPorts {
  /** One JSON request to this Tether's control socket. */
  callSocket(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>
}

export async function runFleet(
  args: string[],
  paths: { socket: string },
  io: { out(text: string): void; err(text: string): void },
  ports: FleetCliPorts,
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
    const envelope = signRelease(
      release,
      join(secretsDir(), 'update-signing-key'),
      ports.apiVersion,
    )
    writeFileSync(join(release, SIGNED_RELEASE), envelope, { mode: 0o600 })
    io.out('Release signed')
    return 0
  }
  if (command === 'push-update') {
    const [name, release, instance = 'default'] = rest
    const settings = readSettings(process.env, paths.socket)
    if (!settings || !name || !release)
      throw new Error('Usage: tether fleet push-update MACHINE RELEASE [INSTANCE]')
    const entry = loadHosts(hostsFilePath(process.env)).hosts.find((host) => host.name === name)
    if (!entry) throw new Error('Machine has no hosts entry')
    const result = await pushRelease(
      release,
      { entry, control: join(settings.peerRoot, name, 'exec.sock'), instance },
      ports,
    )
    io.out(result.stdout || result.output)
    return result.code ?? 1
  }
  if (command === 'verify-update') {
    if (!rest[0]) throw new Error('Usage: tether fleet verify-update ENVELOPE [PINS]')
    verifyRelease(readFileSync(rest[0], 'utf8'), readUpdateKeys(rest[1] || DEFAULT_UPDATE_PINS))
    io.out('Signed release verified')
    return 0
  }
  if (command === 'update-result') {
    const result = updateResult(rest[0] || '', rest[1] || '')
    io.out(JSON.stringify(result))
    return 0
  }
  if (command === 'receive-update') {
    const result = receiveUpdate(
      await input(64 * 1024 * 1024),
      {
        instance: rest[0] || '',
        socket: rest[1] || '',
        stateDir: rest[2] || null,
        id: rest[3] || '',
      },
      ports,
    )
    io.out(result.stdout || result.output)
    return result.code ?? 1
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
      const answer = await ports.callSocket('POST', '/v1/asks', {
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
    const answer = await ports.callSocket('GET', `/v1/asks/${encodeURIComponent(askId)}`)
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
