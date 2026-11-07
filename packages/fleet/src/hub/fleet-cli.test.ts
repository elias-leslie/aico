import { generateKeyPairSync } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { enrollmentCode, fingerprint, publicKeyOf } from '../identity'
import { approvedEnrollment, enrollmentBody, enrollmentQuestion, runFleet } from './fleet-cli'
import { TEST_PORTS } from './testing'

it('requires the exact machine, short code and an answered Approve ask', () => {
  const pin = {
    name: 'peer',
    role: 'full' as const,
    publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey),
  }
  const ask = {
    body: enrollmentBody(pin),
    question: enrollmentQuestion(pin),
    state: 'answered',
    answer: 'Approve',
  }
  expect(approvedEnrollment(pin, ask)).toBe(true)
  expect(enrollmentQuestion(pin)).toContain(fingerprint(pin.publicKey))
  expect(enrollmentQuestion(pin)).toContain('as full')
  expect(approvedEnrollment({ ...pin, role: 'worker' }, ask)).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, body: 'Public key: another key' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, state: 'open' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, answer: 'Reject' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, question: 'Allow another machine?' })).toBe(false)
  const other = { ...pin, publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey) }
  expect(enrollmentCode(pin.name, pin.publicKey)).not.toBe(
    enrollmentCode(other.name, other.publicKey),
  )
  expect(approvedEnrollment(other, ask)).toBe(false)
})

const push = vi.hoisted(() => vi.fn(async () => ({ code: 0, stdout: 'accepted', output: '' })))
vi.mock('./update', async (original) => ({
  ...(await original<typeof import('./update')>()),
  pushRelease: push,
}))
vi.mock('../settings', async (original) => ({
  ...(await original<typeof import('../settings')>()),
  readSettings: () => ({ peerRoot: '/fleet' }),
}))
vi.mock('../hosts', async (original) => ({
  ...(await original<typeof import('../hosts')>()),
  loadHosts: () => ({
    hosts: [
      { name: 'worker', socket: '/run/user/4321/tether/default/control.sock', stateDir: '/state' },
    ],
  }),
}))
it('takes the remote update socket from the hosts entry, independently of this uid', async () => {
  await runFleet(
    ['push-update', 'worker', '/release'],
    { socket: '/local/control.sock' },
    { out: () => {}, err: () => {} },
    { ...TEST_PORTS, callSocket: async () => ({ status: 200, body: null }) },
  )
  expect(push).toHaveBeenCalledWith(
    '/release',
    expect.objectContaining({
      entry: expect.objectContaining({ socket: '/run/user/4321/tether/default/control.sock' }),
      control: '/fleet/worker/exec.sock',
    }),
    expect.objectContaining({ apiVersion: TEST_PORTS.apiVersion }),
  )
})
