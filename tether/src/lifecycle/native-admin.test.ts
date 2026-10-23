import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type AdminRequest,
  nativeAdminApply,
  nativeAdminBinding,
  nativeAdminEnvironment,
  nativeAdminSnapshot,
} from './native-admin'

const THREAD = '00000000-0000-4000-8000-000000000001'
const NEW = '00000000-0000-4000-8000-000000000003'
const EPOCH = '00000000-0000-4000-8000-000000000002'
const request: AdminRequest = {
  kind: 'submit',
  text: '/clear literal café\n界',
  requestKey: 'fixture-1',
  generation: 'b'.repeat(64),
  expectedThreadId: THREAD,
  expectedEpoch: EPOCH,
  expectedInputRevision: 3,
}

async function fixture(
  test: (
    binding: { socket: string; launchId: string },
    calls: Record<string, unknown>[],
  ) => Promise<void>,
  response: (input: Record<string, unknown>) => unknown,
) {
  const runtime = mkdtempSync(join(tmpdir(), 'native-admin-'))
  chmodSync(runtime, 0o700)
  const env = nativeAdminEnvironment(runtime)
  const binding = { socket: env.CODEX_TERMINAL_ADMIN_SOCKET, launchId: env.CODEX_TERMINAL_ADMIN_ID }
  const calls: Record<string, unknown>[] = []
  const server = createServer((client) => {
    let bytes = ''
    client.on('data', (chunk: Buffer) => {
      bytes += chunk.toString('utf8')
      if (!bytes.includes('\n')) return
      const input = JSON.parse(bytes) as Record<string, unknown>
      calls.push(input)
      client.end(`${JSON.stringify(response(input))}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(binding.socket, resolve))
  chmodSync(binding.socket, 0o600)
  try {
    await test(binding, calls)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(runtime, { recursive: true, force: true })
  }
}

function accepted(input: Record<string, unknown>): Record<string, unknown> {
  const params = input.params as Record<string, unknown>
  return {
    state: 'applied',
    reason: 'native_accepted',
    ...params,
    requestDigest: createHash('sha256').update(JSON.stringify(params)).digest('hex'),
    oldThreadId: THREAD,
    newThreadId: THREAD,
    inputRevision: 3,
    acceptedTurnId: 'turn-1',
    clientUserMessageId: NEW,
    contentDigest: createHash('sha256')
      .update(request.kind === 'submit' ? request.text : '')
      .digest('hex'),
  }
}

describe('native admin launch-bound forwarding', () => {
  it('qualifies exact native turn identity/digest with one request and content-free projection', async () => {
    await fixture(async (binding, calls) => {
      expect(
        nativeAdminBinding(
          new Map(
            Object.entries({
              CODEX_TERMINAL_ADMIN_SOCKET: binding.socket,
              CODEX_TERMINAL_ADMIN_ID: binding.launchId,
            }),
          ),
        ),
      ).toEqual(binding)
      const result = await nativeAdminApply(binding, request)
      expect(result).toEqual({
        kind: 'submit',
        requestKey: request.requestKey,
        generation: request.generation,
        expectedThreadId: THREAD,
        expectedEpoch: EPOCH,
        expectedInputRevision: 3,
        applied: true,
        reason: 'native_accepted',
        newThreadId: THREAD,
        acceptedTurnId: 'turn-1',
        clientUserMessageId: NEW,
        contentDigest: createHash('sha256').update(request.text).digest('hex'),
      })
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain(request.text)
    }, accepted)
  })

  it.each([
    'requestDigest',
    'expectedEpoch',
    'expectedThreadId',
    'expectedInputRevision',
    'oldThreadId',
    'newThreadId',
    'acceptedTurnId',
    'clientUserMessageId',
    'contentDigest',
    'state',
    'reason',
  ])('fails uncertain on malformed %s; never retries', async (field) => {
    await fixture(
      async (binding, calls) => {
        expect((await nativeAdminApply(binding, request)).applied).toBeNull()
        expect(calls).toHaveLength(1)
      },
      (input) => ({ ...accepted(input), [field]: 'invalid!' }),
    )
  })

  it.each(['rejected', 'uncertain'])('accepts only correlated %s receipts', async (state) => {
    await fixture(
      async (binding) => {
        expect((await nativeAdminApply(binding, request)).applied).toBe(
          state === 'rejected' ? false : null,
        )
      },
      (input) => ({ ...accepted(input), state, reason: 'input_or_thread_busy' }),
    )
  })

  it('clear remains rejected locally without contacting the native endpoint', async () => {
    await fixture(async (binding, calls) => {
      expect(await nativeAdminApply(binding, { ...request, kind: 'clear' })).toMatchObject({
        applied: false,
        reason: 'native_clear_atomic_handoff_unavailable',
      })
      expect(calls).toEqual([])
    }, accepted)
  })

  it('requires native pins before forwarding and rejects nonprivate sockets', async () => {
    await fixture(async (binding, calls) => {
      expect(
        (await nativeAdminApply(binding, { ...request, expectedEpoch: undefined })).applied,
      ).toBe(false)
      expect(calls).toEqual([])
      chmodSync(binding.socket, 0o666)
      expect(
        nativeAdminBinding(
          new Map(
            Object.entries({
              CODEX_TERMINAL_ADMIN_SOCKET: binding.socket,
              CODEX_TERMINAL_ADMIN_ID: binding.launchId,
            }),
          ),
        ),
      ).toBeNull()
    }, accepted)
  })

  it('snapshot publishes native pins/readiness, not response text or ambient bindings', async () => {
    await fixture(
      async (binding) => {
        expect(await nativeAdminSnapshot(binding)).toEqual({
          available: true,
          protocol: 'codexTerminalAdmin.v1',
          epoch: EPOCH,
          inputRevision: 3,
          ready: true,
          currentThreadId: THREAD,
          operations: ['submit'],
        })
      },
      (input) => ({
        available: true,
        protocol: 'codexTerminalAdmin.v1',
        launchId: input.launchId,
        epoch: EPOCH,
        inputRevision: 3,
        ready: true,
        threadId: THREAD,
        text: 'must not leave native owner',
      }),
    )
  })
})
