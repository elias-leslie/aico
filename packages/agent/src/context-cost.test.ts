import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as context from '@aico/context'
import { openContext, recentDeliveries } from '@aico/context'
import { expect, it, vi } from 'vitest'
import { recordAgentContext } from './context-cost'

it('records the unchanged actual prelude, and marks use from its own messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-prelude-'))
  const path = join(dir, 'context.db')
  const db = openContext(path)
  db.prepare('INSERT INTO project_permissions (project_id, root_path) VALUES (?, ?)').run(
    'sample',
    '/sample',
  )
  const parts = [
    {
      id: 'rule:aico-agent',
      title: 'Agent rules',
      type: 'rule' as const,
      text: 'Work in /sample.',
    },
    {
      id: 'file:/sample/AGENTS.md',
      title: 'Project instructions',
      type: 'file' as const,
      text: '<project_instructions>Keep work.</project_instructions>',
    },
  ]
  const before = structuredClone(parts)
  try {
    const record = recordAgentContext(
      path,
      { id: 'test-run', role: 'builder', cwd: '/sample' },
      parts,
      () => {},
    )
    expect(parts).toEqual(before)
    expect(recentDeliveries(db)[0]).toMatchObject({
      tool: 'aico-agent',
      project: 'sample',
      role: 'builder',
      bytes: Buffer.byteLength(parts.map((p) => p.text).join('\n\n')),
    })
    record?.message({
      role: 'assistant',
      content: [{ type: 'text', text: 'Applied rule:aico-agent.' }],
      timestamp: Date.now(),
    } as never)
    // A pre-compaction read is persisted as it happens; finish needs no retained messages.
    record?.message({
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'read', arguments: { path: '/sample/AGENTS.md' } }],
      timestamp: Date.now(),
    } as never)
    record?.finish(true)
    expect(recentDeliveries(db)[0]!.items.find((i) => i.type === 'rule')?.use).toBe('used')
    expect(recentDeliveries(db)[0]!.items.find((i) => i.type === 'file')?.use).toBe('used')
    const revised = recordAgentContext(
      path,
      { id: 'new-run', role: 'builder', cwd: '/sample' },
      [{ ...parts[1]!, text: 'Changed file.' }],
      () => {},
    )
    revised?.message({
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'read', arguments: { path: '/sample/AGENTS.md' } }],
      timestamp: 1000,
    } as never)
    revised?.finish(true)
    expect(recentDeliveries(db)[0]!.items[0]!.use).toBe('unknown')
    const errors: string[] = []
    const contested = recordAgentContext(
      path,
      { id: 'contested', role: 'builder', cwd: '/sample' },
      parts,
      (line) => errors.push(line),
    )
    const locked = vi.spyOn(context, 'openContext').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    contested?.message({
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'read', arguments: { path: '/sample/AGENTS.md' } }],
      timestamp: Date.now(),
    } as never)
    locked.mockRestore()
    contested?.message({
      role: 'assistant',
      content: [{ type: 'text', text: 'Finished.' }],
      timestamp: Date.now(),
    } as never)
    contested?.finish(true)
    expect(errors.some((e) => e.includes('locked'))).toBe(true)
    expect(recentDeliveries(db)[0]!.observed).toBe(false)
    expect(
      recordAgentContext(
        undefined,
        { id: 'test', role: 'builder', cwd: '/sample' },
        parts,
        () => {},
      ),
    ).toBeUndefined()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
