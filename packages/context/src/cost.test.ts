import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  budgetHint,
  COST,
  estimatedTokens,
  observeDelivery,
  recentDeliveries,
  tokenBudget,
  unusedItems,
} from './cost'
import { type Database, openContext, putSetting } from './db'
import { DELIVERY, deliver, recordDelivery } from './deliver'
import { contextCatalog, editPrompt, editRole } from './editor'
import { loadPolicy } from './launch'
import { getPrompt, putPrompt } from './prompts'

const now = new Date('2026-11-04T12:00:00Z')
const databases: Database[] = []
function seeded() {
  const db = openContext(':memory:')
  databases.push(db)
  db.prepare('INSERT INTO project_permissions (project_id) VALUES (?)').run('sample')
  db.prepare(
    'INSERT INTO roles (name, label, context, position, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('builder', 'Builder', 'default', 0, now.toISOString())
  putPrompt(
    db,
    {
      id: 1,
      slug: 'guide',
      name: 'Project guide',
      description: '',
      content: 'Use the project checks.',
      kind: 'standard',
      isGlobal: true,
      bootEligible: true,
      contextPolicy: { scope: 'global' },
      updatedAt: now.toISOString(),
    },
    'test',
  )
  db.prepare(`INSERT INTO memories (id, scope, tier, summary, content, created_at, updated_at)
    VALUES ('abc12345-full', 'global', 'guardrail', 'Keep useful work', 'Keep useful work.', ?, ?)`).run(
    now.toISOString(),
    now.toISOString(),
  )
  return db
}
function add(db: Database, session: string, text = 'Read this skill.') {
  const d = deliver(db, {
    tool: 'codex',
    role: 'builder',
    project: 'sample',
    session,
    sources: [
      { id: 'skill:/skills/review/SKILL.md', title: 'Review skill', type: 'skill', text },
      {
        id: 'file:/sample/AGENTS.md',
        title: 'Project instructions',
        type: 'file',
        text: 'Project rules.',
      },
      { id: 'rule:guard', title: 'Publication guard', type: 'rule', text: 'Keep local.' },
    ],
  })
  recordDelivery(db, d, 'test', now)
  return recentDeliveries(db, now)[0]!
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('context inventory and use', () => {
  it('upgrades a version-3 inventory opened before the role-context review fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-context-v3-'))
    const path = join(dir, 'context.db')
    try {
      const old = openContext(path)
      old.exec('DROP TABLE role_context_overrides; PRAGMA user_version = 3')
      old.close()
      const upgraded = openContext(path)
      try {
        expect(upgraded.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 })
        expect(
          upgraded.prepare('SELECT count(*) AS n FROM role_context_overrides').get(),
        ).toMatchObject({ n: 0 })
      } finally {
        upgraded.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('edits named-role context without turning it into a launch job', () => {
    const db = seeded()
    putSetting(db, 'launch', { version: 5, about: '', usage_providers: [], work_roles: [] })
    db.prepare('UPDATE roles SET context = NULL WHERE name = ?').run('builder')
    const before = loadPolicy(db)!.jobs.length
    const role = contextCatalog(db).roles[0]!
    editRole(db, role.name, { ...role, description: 'New description' }, '2026-11-04T12:01:00Z')
    expect(loadPolicy(db)!.jobs).toHaveLength(before)
    const next = contextCatalog(db).roles[0]!
    editRole(db, next.name, { ...next, context: 'blank-slate' }, '2026-11-04T12:02:00Z')
    expect(loadPolicy(db)!.jobs).toHaveLength(before)
    expect(deliver(db, { tool: 'codex', role: role.name }).text).toBe('')
  })
  it('alerts only for the version in the latest delivery', () => {
    const db = seeded()
    for (let n = 0; n < COST.minObservedSessions; n++)
      observeDelivery(db, add(db, `old-${n}`), [], true, `codex:${n}`, now)
    expect(unusedItems(recentDeliveries(db, now)).length).toBeGreaterThan(0)
    const latest = add(db, 'new', 'Revised skill text.')
    observeDelivery(
      db,
      latest,
      [
        {
          role: 'assistant',
          kind: 'tool_call',
          tool: 'read',
          text: '/skills/review/SKILL.md',
          at: now.getTime(),
        },
      ],
      true,
      'codex:new',
      now,
    )
    expect(unusedItems(recentDeliveries(db, now)).some((i) => i.id.startsWith('skill:'))).toBe(
      false,
    )
  })
  it('keeps every loaded kind, estimated sizes and its agent/project, without bodies', () => {
    const db = seeded()
    const d = add(db, 'one')
    expect(new Set(d.items.map((i) => i.type))).toEqual(
      new Set(['prompt', 'memory', 'skill', 'file', 'rule']),
    )
    expect(d).toMatchObject({
      tool: 'codex',
      role: 'builder',
      project: 'sample',
      tokens: estimatedTokens(d.bytes),
    })
    expect(d.items.every((i) => i.tokens === estimatedTokens(i.bytes) && i.use === 'unknown')).toBe(
      true,
    )
    expect(JSON.stringify(db.prepare('SELECT * FROM delivery_items').all())).not.toContain(
      'Read this skill.',
    )
  })
  it('needs complete observations in distinct sessions; user/system echoes do not count', () => {
    const db = seeded()
    for (let n = 0; n < COST.minObservedSessions; n++) {
      const d = add(db, `session-${n}`)
      observeDelivery(
        db,
        d,
        [{ role: 'user', kind: 'text', text: '[G:abc12345] prompt:guide', at: now.getTime() }],
        true,
        `codex:${n}`,
        now,
      )
    }
    let d = recentDeliveries(db, now)[0]!
    expect(d.items.every((i) => i.use === (i.type === 'rule' ? 'unknown' : 'unused'))).toBe(true)
    observeDelivery(
      db,
      d,
      [
        { role: 'assistant', kind: 'text', text: 'Applied [G:abc12345].', at: now.getTime() },
        {
          role: 'assistant',
          kind: 'tool_call',
          tool: 'read',
          text: '/skills/review/SKILL.md',
          at: now.getTime(),
        },
      ],
      true,
      'codex:last',
      now,
    )
    d = recentDeliveries(db, now)[0]!
    expect(d.items.find((i) => i.type === 'memory')?.use).toBe('used')
    expect(d.items.find((i) => i.type === 'skill')?.use).toBe('used')
    expect(d.items.find((i) => i.type === 'prompt')?.use).toBe('unused')
  })
  it('keeps repeated hooks, incomplete evidence and new content from qualifying', () => {
    const db = seeded()
    for (let n = 0; n < COST.minObservedSessions; n++)
      observeDelivery(db, add(db, 'same'), [], true, 'codex:same', now)
    expect(recentDeliveries(db, now)[0]!.items.every((i) => i.use === 'unknown')).toBe(true)
    for (let n = 0; n < COST.minObservedSessions; n++)
      observeDelivery(db, add(db, `other-${n}`), [], true, 'codex:other', now)
    const changed = add(db, 'changed', 'Edit this skill.') // Same byte length as the prior text.
    expect(changed.items.find((i) => i.type === 'skill')?.use).toBe('unknown')
    observeDelivery(db, changed, [], false, 'codex:changed', now)
    const latest = recentDeliveries(db, now)[0]!
    // New content needs its own observed sessions; unchanged content keeps the verdict of
    // its observed sessions despite this unobserved one.
    expect(latest.items.find((i) => i.type === 'skill')?.use).toBe('unknown')
    expect(latest.items.find((i) => i.type === 'prompt')?.use).toBe('unused')
  })
  it('never makes an always-on harness rule an unused candidate', () => {
    const db = seeded()
    for (let n = 0; n < COST.minObservedSessions; n++)
      observeDelivery(db, add(db, `rule-${n}`), [], true, `codex:rule-${n}`, now)
    const items = recentDeliveries(db, now)[0]!.items
    expect(items.find((i) => i.type === 'rule')?.use).toBe('unknown')
    expect(items.some((i) => i.use === 'unused')).toBe(true)
    expect(unusedItems(recentDeliveries(db, now)).some((i) => i.id.startsWith('rule:'))).toBe(false)
  })
  it('separates roles/projects and excludes configured private projects', () => {
    const db = seeded()
    add(db, 'one')
    db.prepare('UPDATE deliveries SET project = ?').run(COST.excludedProjects[0]!)
    expect(recentDeliveries(db, now)).toEqual([])
  })
  it('keeps cut items out of use candidates and preserves required instructions', () => {
    const db = seeded()
    const d = deliver(
      db,
      {
        tool: 'codex',
        project: 'sample',
        sources: [
          {
            id: 'file:required',
            title: 'Required',
            type: 'file',
            text: 'x'.repeat(500),
            required: true,
          },
          { id: 'file:optional', title: 'Optional', type: 'file', text: 'y'.repeat(500) },
        ],
      },
      { ...DELIVERY, tools: { ...DELIVERY.tools, codex: { budgetBytes: 100 } } },
    )
    expect(d.sections.flatMap((s) => s.items.map((i) => i.id))).toContain('file:required')
    expect(d.cut.flatMap((s) => s.items.map((i) => i.id))).toContain('file:optional')
    expect(d.over).toBe(true)
    recordDelivery(db, d, 'test', now)
    expect(recentDeliveries(db, now)[0]!.items.find((i) => i.id === 'file:optional')).toMatchObject(
      { cut: true, use: 'unknown' },
    )
  })
  it('applies specific budgets and delivers one hint naming the largest items', () => {
    const db = seeded()
    const put = db.prepare(
      'INSERT INTO context_budgets (harness, role, warn_tokens, updated_at) VALUES (?, ?, ?, ?)',
    )
    put.run('*', '*', 10000, now.toISOString())
    put.run('codex', '*', 1000, now.toISOString())
    put.run('*', 'builder', 25, now.toISOString())
    expect(tokenBudget(db, 'codex', 'builder')).toBe(25)
    const d = deliver(db, {
      tool: 'codex',
      role: 'builder',
      project: 'sample',
      sources: [
        {
          id: 'file:large',
          title: 'Large instructions',
          type: 'file',
          text: 'x'.repeat(400),
          required: true,
        },
      ],
    })
    expect(d.sections.filter((s) => s.id === 'context-budget')).toHaveLength(1)
    expect(d.text).toContain('Large instructions (~100)')
    expect(d.bytes).toBe(Buffer.byteLength(d.text))
    expect(budgetHint(db, { ...d, bytes: 1 })).toBeNull()
  })
  it('saves prompt and role edits, rejects stale writes, and loads linked prompts', () => {
    const db = seeded()
    const p = getPrompt(db, 'guide')!
    editPrompt(
      db,
      p.slug,
      { ...p, name: 'Local', content: 'Local text', contextPolicy: { scope: '' } },
      '2026-11-04T12:01:00Z',
    )
    expect(() => editPrompt(db, p.slug, { ...p }, now.toISOString())).toThrow('changed')
    const r = contextCatalog(db).roles[0]!
    editRole(db, r.name, { ...r, prompts: [p.id] }, '2026-11-04T12:01:00Z')
    expect(deliver(db, { tool: 'codex', role: 'builder' }).text).toContain('Local text')
    expect(() => editRole(db, r.name, { ...r, prompts: [999] }, now.toISOString())).toThrow()
  })
})
