import { execFile } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import modelGuard, { lookup } from '../integrations/pi/model-guard'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it('reads launch defaults through Aico with literal model and project arguments', async () => {
  vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
    ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(
      null,
      JSON.stringify({ rows: [{ allowed: false, deny_reason: 'Role denies this provider.' }] }),
      '',
    )
  }) as typeof execFile)
  expect(
    await lookup('hunting', 'sample', { key: 'anthropic/claude', provider: 'anthropic' }, 1000), // gitleaks:allow -- model id fixture
  ).toEqual({ kind: 'denied', reason: 'Role denies this provider.' })
  expect(execFile).toHaveBeenCalledWith(
    'aico',
    [
      'models',
      'route',
      '--role',
      'hunting',
      '--tool',
      'claude-code',
      '--json',
      '--project',
      'sample',
    ],
    { timeout: 1000 },
    expect.any(Function),
  )
})

it('aborts a denied provider request after switching away from Agent Hub', async () => {
  vi.stubEnv('ST_WORK_ROLE', 'hunting')
  vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
    ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(
      null,
      JSON.stringify({ rows: [{ allowed: false, deny_reason: 'Denied by Aico.' }] }),
      '',
    )
  }) as typeof execFile)
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  modelGuard({
    on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[name] = handler
    },
  } as never)
  const abort = vi.fn()
  const notify = vi.fn()
  await handlers.before_provider_request?.(
    { payload: { model: 'claude' } },
    { model: { id: 'claude', provider: 'anthropic' }, abort, hasUI: true, ui: { notify } },
  )
  expect(abort).toHaveBeenCalledOnce()
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Denied by Aico.'), 'error')
})

it('refuses Claude when Aico does not know the work role', async () => {
  vi.stubEnv('ST_WORK_ROLE', 'definitely-unknown')
  vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
    ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(
      Object.assign(new Error('Unknown work role'), { code: 2 }),
      '',
      '',
    )
  }) as typeof execFile)
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  modelGuard({
    on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[name] = handler
    },
  } as never)
  const abort = vi.fn()
  await handlers.before_provider_request?.(
    { payload: { model: 'claude' } },
    { model: { id: 'claude', provider: 'anthropic' }, abort, hasUI: true, ui: { notify: vi.fn() } },
  )
  expect(abort).toHaveBeenCalledOnce()
})
