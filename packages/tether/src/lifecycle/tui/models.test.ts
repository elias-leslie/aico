import { execFile } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listsModel, parseModelTable } from './models'
import type { TuiSpec } from './spec'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const TABLE = `provider     model                context  max-out  thinking  images
opencode-go  deepseek-v4.1-flash  1M       384K     yes       yes
openai       gpt-6-sol            400K     128K     yes       yes
`

const pi = {
  slug: 'pi',
  command: ['pi'],
  env: { PATH: '/pane/path' },
  modelSelection: {
    model: ['--model'],
    modelProvider: ['--provider'],
    listModels: ['--list-models'],
  },
} as unknown as TuiSpec

function answer(error: Error | null, stdout: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args.at(-1) as (e: Error | null, out: string) => void
    cb(error, stdout)
  }) as never)
}

describe('model list', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset()
  })

  it('reads provider/model pairs under the header', () => {
    expect(parseModelTable(`Loading…\n${TABLE}`)).toEqual(
      new Set(['opencode-go/deepseek-v4.1-flash', 'openai/gpt-6-sol']),
    )
    expect(parseModelTable('Error: something')).toBeNull()
  })

  it('asks the tool on the pane PATH and says whether it lists the model', async () => {
    answer(null, TABLE)
    expect(await listsModel(pi, 'opencode-go/deepseek-v4.1-flash')).toBe(true)
    expect(await listsModel(pi, 'nope/nope')).toBe(false)
    expect(execFile).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'exec "$@"', 'aico-list-models', 'pi', '--list-models'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: '/pane/path' }) }),
      expect.any(Function),
    )
  })

  it('lets the launch go ahead when the list cannot be read', async () => {
    answer(new Error('no credentials'), '')
    expect(await listsModel(pi, 'nope/nope')).toBeNull()
    answer(null, 'provider  model\n')
    expect(await listsModel(pi, 'nope/nope')).toBeNull()
    const codex = { ...pi, modelSelection: { model: ['--model'] } } as TuiSpec
    expect(await listsModel(codex, 'gpt-6')).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(2)
  })
})
