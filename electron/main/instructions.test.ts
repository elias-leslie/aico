import { describe, expect, it, vi } from 'vitest'
import { createInstructions, parseChoice, usableContent } from './instructions'

const OLD = '0cd0d7e2-2403-4fb6-8747-0651250c881c'
const NEW = '20110df2-9d3f-4e0d-85af-38d9b844a282'
const NEWER = 'ed32d259-1ca6-4405-871e-02f0ae54f957'

/** `st --no-compact prompt ...` answering from `replies` (keyed by subcommand). */
function setup(replies: Record<string, unknown>) {
  const execFile = vi.fn(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      const reply = replies[args[2] as string]
      if (reply instanceof Error) callback(reply, '')
      else callback(null, JSON.stringify(reply))
    },
  )
  return { execFile, instructions: createInstructions({ st: '/home/o/bin/st', execFile }) }
}

const revisions = {
  revisions: [
    // The newest revision repeats the current content: the newest one is current.
    {
      id: NEWER,
      content: 'Review.',
      change_reason: 'restore',
      created_at: '2026-10-26T12:00:00Z',
    },
    {
      id: NEW,
      prompt_name: 'Code Reviewer',
      content: 'Review.',
      content_hash: 'ab12',
      change_reason: 'tighten',
      created_at: '2026-10-20T12:00:00Z',
    },
    { id: OLD, content: "Has '''", change_reason: 'old', created_at: null },
  ],
  total: 3,
}

describe('chosen instructions', () => {
  it('lists enabled prompts by name', async () => {
    const { instructions, execFile } = setup({
      list: {
        prompts: [
          { slug: 'zeta', name: 'Zeta', description: 'z', enabled: true, content: 'x' },
          { slug: 'off', name: 'Off', enabled: false },
          { slug: 'alpha', name: 'Alpha', enabled: true },
        ],
      },
    })
    expect(await instructions.prompts()).toEqual({
      status: 'ready',
      items: [
        { slug: 'alpha', name: 'Alpha', description: '' },
        { slug: 'zeta', name: 'Zeta', description: 'z' },
      ],
    })
    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual([
      '/home/o/bin/st',
      ['--no-compact', 'prompt', 'list'],
    ])
  })

  it('says unavailable when Agent Hub cannot be read, not empty', async () => {
    const { instructions } = setup({ list: new Error('down'), revisions: new Error('down') })
    expect(await instructions.prompts()).toEqual({ status: 'unavailable', items: [] })
    expect(await instructions.revisions('code-reviewer')).toEqual({
      status: 'unavailable',
      items: [],
    })
  })

  it('marks the newest revision holding the current content, and unusable ones', async () => {
    const { instructions } = setup({ revisions, get: { content: 'Review.' } })
    const listing = await instructions.revisions('code-reviewer')
    expect(listing.items.map((r) => [r.id, r.current, r.usable])).toEqual([
      [NEWER, true, true],
      [NEW, false, true],
      [OLD, false, false],
    ])
    expect(listing.items[1]).toMatchObject({ reason: 'tighten', createdAt: '2026-10-20T12:00:00Z' })
  })

  it('builds the snapshot Tether keeps, and refuses a gone or unusable revision', async () => {
    const { instructions } = setup({ revisions })
    expect(await instructions.snapshot({ prompt: 'code-reviewer', revision: NEW })).toEqual({
      prompt: 'code-reviewer',
      name: 'Code Reviewer',
      revision: NEW,
      contentHash: 'ab12',
      createdAt: '2026-10-20T12:00:00Z',
      content: 'Review.',
    })
    await expect(instructions.snapshot({ prompt: 'code-reviewer', revision: OLD })).rejects.toThrow(
      "can't be used",
    )
    await expect(
      instructions.snapshot({
        prompt: 'code-reviewer',
        revision: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow('no longer lists that revision')
  })

  it('accepts only a slug and a full revision id from the renderer', () => {
    expect(parseChoice({ prompt: 'code-reviewer', revision: NEW })).toEqual({
      prompt: 'code-reviewer',
      revision: NEW,
    })
    expect(parseChoice({ prompt: 'code-reviewer', revision: '20110df2' })).toBeNull()
    expect(parseChoice({ prompt: '-x', revision: NEW })).toBeNull()
    expect(parseChoice('code-reviewer')).toBeNull()
  })

  it('applies Tether content limits', () => {
    expect(usableContent('ok\n\tfine')).toBe(true)
    expect(usableContent('  ')).toBe(false)
    expect(usableContent('a\u0001b')).toBe(false)
    expect(usableContent('x'.repeat(64 * 1024 + 1))).toBe(false)
  })
})
