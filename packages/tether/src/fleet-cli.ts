// Enrollment crosses the owner's existing Needs-you surface. Only public key
// material is displayed or copied; root pins it after the exact ask is approved.
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { runExec } from '@aico/fleet/exec'
import { enrollmentCode, loadIdentity, machineName } from '@aico/fleet/identity'
import { approvePin, type Pin, parsePins } from '@aico/fleet/trust'
import { callSocket } from './client'
import type { TetherPaths } from './config'

export function enrollmentQuestion(pin: Pin): string {
  return `Allow ${pin.name} to join Aico with code ${enrollmentCode(pin.name, pin.publicKey)}?`
}

export function approvedEnrollment(pin: Pin, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const ask = value as Record<string, unknown>
  return (
    ask.state === 'answered' && ask.answer === 'Approve' && ask.question === enrollmentQuestion(pin)
  )
}

export async function runFleet(
  args: string[],
  paths: TetherPaths,
  io: { out(text: string): void; err(text: string): void },
): Promise<number> {
  const [command, ...rest] = args
  if (command === 'exec') {
    const at = rest.indexOf('--')
    if (at !== 1 || !rest[0] || !rest[2])
      throw new Error('Usage: tether fleet exec SOCKET -- COMMAND [ARGS]')
    return runExec(rest[0], rest.slice(2))
  }
  if (command === 'identity') {
    const dir =
      process.env.AICO_DATA_DIR ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'aico')
    const identity = loadIdentity(dir, machineName(hostname()))
    io.out(
      JSON.stringify({
        name: identity.name,
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
        body: `This machine will exchange sessions, notes and job leases with approved Aico peers. Compare its displayed code before approving.\nPublic key: ${pin.publicKey}`,
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
    if (answer.status !== 200 || !approvedEnrollment(pin, answer.body))
      throw new Error('The owner has not approved this exact machine and code')
    approvePin(allowlist, pin, enrollmentCode(pin.name, pin.publicKey))
    io.out(`${pin.name} is approved.`)
    return 0
  }
  io.err(
    'Usage: tether fleet identity | enroll PUBLIC_FILE | approve PUBLIC_FILE ASK_ID ALLOWLIST | exec SOCKET -- COMMAND [ARGS]',
  )
  return 2
}
