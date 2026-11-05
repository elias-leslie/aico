// deliver() and `aico context deliver` against the shared fixtures
// (contracts/context-delivery-fixtures.json, seeded by delivery-fixture.ts), and
// the CLI's JSON against its contract (contracts/context-delivery.schema.json).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ContextCliIo, runContextCli } from './cli'
import { openContext } from './db'
import {
  DELIVERY,
  type Delivery,
  deliver,
  deliveryTools,
  recordDelivery,
  setDeliveryTool,
} from './deliver'
import { DELIVERY_FIXTURE, fixtureDb, fixtureRequest } from './delivery-fixture'

const memoryIds = (delivery: Delivery) =>
  delivery.sections.flatMap((section) =>
    section.items
      .filter((item) => item.id.startsWith('memory:'))
      .map((item) => item.id.slice('memory:'.length, 'memory:'.length + 8)),
  )

describe('deliver() against the shared fixtures', () => {
  const db = fixtureDb()
  for (const entry of DELIVERY_FIXTURE.cases)
    it(entry.name, () => {
      const { request, settings } = fixtureRequest(entry)
      const delivery = deliver(db, request, settings)
      expect(delivery.sections.map((section) => section.id)).toEqual(entry.sections)
      expect(memoryIds(delivery)).toEqual(entry.memories)
      expect(delivery.cut.map((section) => section.id)).toEqual(entry.cut)
      expect(delivery.over).toBe(entry.over ?? false)
      if (entry.text !== undefined) expect(delivery.text).toBe(entry.text)
      expect(delivery.bytes).toBe(Buffer.byteLength(delivery.text))
      if (!entry.over) expect(delivery.bytes).toBeLessThanOrEqual(delivery.budget)
      // Each kept section's bytes, plus the blank lines between them, are the text.
      const joined = delivery.sections.reduce((sum, section) => sum + section.bytes, 0)
      expect(delivery.bytes).toBe(joined + Math.max(0, delivery.sections.length - 1) * 2)
    })

  it('reports a computed block it could not read, and still delivers the rest', () => {
    const delivery = deliver(db, {
      tool: 'codex',
      project: 'alpha',
      toolUsage: { error: 'st tools manifest: timed out' },
      activity: [],
    })
    expect(delivery.missing).toEqual([{ id: 'tool-usage', reason: 'st tools manifest: timed out' }])
    expect(delivery.sections.map((section) => section.id)).not.toContain('tool-usage')
    expect(delivery.text).toContain('## Safety Rules')
  })

  it('takes tool aliases and refuses an unknown tool', () => {
    expect(deliver(db, { tool: 'claude' }).tool).toBe('claude-code')
    expect(() => deliver(db, { tool: 'emacs' })).toThrow('unknown tool emacs')
  })

  it('keeps the per-item inventory, cut items marked', () => {
    const [entry] = DELIVERY_FIXTURE.cases.filter((c) => c.cut.length)
    const { request, settings } = fixtureRequest(entry as (typeof DELIVERY_FIXTURE.cases)[number])
    const delivery = deliver(db, request, settings)
    recordDelivery(db, delivery, 'launch', new Date(DELIVERY_FIXTURE.now))
    const row = db.prepare('SELECT * FROM deliveries').get() as Record<string, unknown>
    expect(row).toMatchObject({
      tool: delivery.tool,
      project: 'alpha',
      channel: 'launch',
      hash: delivery.hash,
      bytes: delivery.bytes,
      budget: delivery.budget,
      over: 0,
    })
    const items = db
      .prepare('SELECT section, kind, item, bytes, cut FROM delivery_items ORDER BY position')
      .all() as { section: string; item: string; bytes: number; cut: number }[]
    const kept = items.filter((item) => !item.cut)
    expect(kept.map((item) => item.item)).toEqual(
      delivery.sections.flatMap((section) => section.items.map((item) => item.id)),
    )
    expect(items.filter((item) => item.cut).map((item) => item.section)).toEqual(
      delivery.cut.flatMap((section) => section.items.map(() => section.id)),
    )
    expect(items.every((item) => item.bytes > 0)).toBe(true)
  })

  it('switches tools on and off by id', () => {
    const switched = fixtureDb()
    expect(deliveryTools(switched)).toEqual([])
    expect(setDeliveryTool(switched, 'claude', true)).toEqual(['claude-code'])
    expect(setDeliveryTool(switched, 'pi', true)).toEqual(['claude-code', 'pi'])
    expect(setDeliveryTool(switched, 'claude-code', false)).toEqual(['pi'])
  })

  it('every tool in the data file has a budget', () => {
    for (const tool of Object.values(DELIVERY.tools)) expect(tool.budgetBytes).toBeGreaterThan(0)
  })
})

describe('aico context deliver', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-deliver-'))
  const dbPath = join(dir, 'context.db')
  fixtureDb(dbPath).close()
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** `tree` maps a pid to its parent: the processes above the CLI (pid 100). */
  function run(argv: string[], env: NodeJS.ProcessEnv = {}, tree: Record<number, number> = {}) {
    const out: string[] = []
    const err: string[] = []
    const io: ContextCliIo = {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      dbPath,
      machine: 'test',
      statusUrl: null,
      fetch,
      now: () => new Date(DELIVERY_FIXTURE.now),
      dataDir: '/nowhere',
      agentHub: {
        checkout: '/nowhere',
        source: () => {
          throw new Error('not asked')
        },
      },
      delivery: {
        env,
        pid: 100,
        parentOf: (pid) => tree[pid] ?? null,
        toolUsage: async () => DELIVERY_FIXTURE.toolUsage,
        activity: async () =>
          DELIVERY_FIXTURE.activity.map((entry) => ({ ...entry, at: Date.parse(entry.at) })),
      },
    }
    return runContextCli('context', ['deliver', ...argv], io).then((code) => ({
      code,
      out: out.join(''),
      err: err.join(''),
    }))
  }
  const first = DELIVERY_FIXTURE.cases[0] as (typeof DELIVERY_FIXTURE.cases)[number]
  function deliveries() {
    const db = openContext(dbPath)
    try {
      return db.prepare('SELECT channel, session FROM deliveries ORDER BY id').all()
    } finally {
      db.close()
    }
  }

  it('prints the text by default, and records nothing', async () => {
    const result = await run([
      '--tool',
      'claude-code',
      '--project',
      'alpha',
      '--session',
      'a1b2c3d4',
    ])
    expect(result).toEqual({ code: 0, out: `${first.text}\n`, err: '' })
    expect(deliveries()).toEqual([])
  })

  it('wraps the text for a Claude or Codex hook and records the delivery', async () => {
    const result = await run([
      '--tool',
      'claude',
      '--project',
      'alpha',
      '--session',
      'a1b2c3d4',
      '--format',
      'claude',
    ])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: first.text },
    })
    expect(deliveries()).toEqual([{ channel: 'hook:claude', session: 'a1b2c3d4' }])
  })

  it('reads the project and session from the environment', async () => {
    const result = await run(['--tool', 'claude-code', '--format', 'json'], {
      AICO_PROJECT_ID: 'alpha',
      AICO_SESSION_ID: 'a1b2c3d4',
    })
    const delivery = JSON.parse(result.out) as Delivery
    expect(delivery).toMatchObject({ project: 'alpha', session: 'a1b2c3d4', text: first.text })
  })

  it('says nothing in the agent the launch delivered to, unless forced', async () => {
    const args = ['--tool', 'codex', '--project', 'alpha', '--format', 'codex']
    // hook (100) <- aico-hook (90) <- agent (80): the launched agent is two parents up.
    const tree = { 100: 90, 90: 80, 80: 70 }
    const marker = { AICO_CONTEXT_DELIVERED: 'abc', AICO_CONTEXT_PID: '80' }
    expect(await run(args, marker, tree)).toEqual({ code: 0, out: '', err: '' })
    expect(await run(args, { AGENT_HUB_CONTEXT_PREINJECTED_HASH: 'abc' })).toEqual({
      code: 0,
      out: '',
      err: '',
    })
    expect((await run([...args, '--force'], marker, tree)).out).toContain('additionalContext')
  })
  it('links the latest launch to its exact native conversation even when injection stands down', async () => {
    const db = openContext(dbPath)
    try {
      recordDelivery(
        db,
        deliver(db, { tool: 'codex', session: 'own-proof', role: 'testing' }),
        'launch',
        new Date(DELIVERY_FIXTURE.now),
      )
    } finally {
      db.close()
    }
    await run(
      ['--tool', 'codex', '--session', 'native-proof', '--format', 'codex'],
      { AICO_SESSION_ID: 'own-proof', AICO_CONTEXT_DELIVERED: 'abc', AICO_CONTEXT_PID: '80' },
      { 100: 90, 90: 80 },
    )
    const read = openContext(dbPath)
    try {
      expect(
        read
          .prepare(
            'SELECT o.source FROM context_observations o JOIN deliveries d ON d.id = o.delivery_id WHERE d.session = ?',
          )
          .get('own-proof'),
      ).toMatchObject({ source: 'codex:native-proof' })
    } finally {
      read.close()
    }
  })

  it('delivers to a session the launched agent started in turn', async () => {
    const args = ['--tool', 'codex', '--project', 'alpha', '--format', 'codex']
    // `codex exec` from a Claude session: hook (100) <- aico-hook (90) <- codex (85) <-
    // bash (82) <- claude (80), and the marker is Claude's.
    const tree = { 100: 90, 90: 85, 85: 82, 82: 80 }
    const marker = { AICO_CONTEXT_DELIVERED: 'abc', AICO_CONTEXT_PID: '80' }
    expect((await run(args, marker, tree)).out).toContain('additionalContext')
    // The marker alone is not enough, and neither is an unreadable tree.
    expect((await run(args, { AICO_CONTEXT_DELIVERED: 'abc' }, tree)).out).toContain(
      'additionalContext',
    )
    expect((await run(args, marker)).out).toContain('additionalContext')
  })

  it('still prints the context when the inventory cannot be written', async () => {
    const locked = join(dir, 'locked.db')
    fixtureDb(locked).close()
    const db = openContext(locked)
    db.exec('DROP TABLE delivery_items; DROP TABLE deliveries')
    db.close()
    const out: string[] = []
    const err: string[] = []
    const code = await runContextCli(
      'context',
      ['deliver', '--tool', 'codex', '--project', 'alpha', '--format', 'codex'],
      {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        dbPath: locked,
        machine: 'test',
        statusUrl: null,
        fetch,
        now: () => new Date(DELIVERY_FIXTURE.now),
        agentHub: { checkout: '', source: () => ({}) as never },
        delivery: { env: {}, toolUsage: async () => '', activity: async () => [] },
      },
    )
    expect(code).toBe(0)
    expect(out.join('')).toContain('## Safety Rules')
    expect(err.join('')).toMatch(/^aico context deliver: delivery not recorded: /)
  })

  it('delivers Pi context through Aico without the retired Agent Hub extension', async () => {
    const args = ['--tool', 'pi', '--project', 'alpha', '--format', 'pi']
    expect((await run(args)).out).toContain('## Alpha Policy')
    expect((await run(args, { AGENT_HUB_CONTEXT_BYPASS: '1' })).out).toContain('## Alpha Policy')
  })

  it('prints nothing for a Blank Slate role', async () => {
    const result = await run(
      ['--tool', 'pi', '--project', 'alpha', '--role', 'testing', '--format', 'pi'],
      { AGENT_HUB_CONTEXT_BYPASS: '1' },
    )
    expect(result).toEqual({ code: 0, out: '', err: '' })
  })

  it('exits 2 on a usage error and 1 when the file cannot be read', async () => {
    expect((await run(['--project', 'alpha'])).code).toBe(2)
    expect((await run(['--tool', 'emacs'])).code).toBe(2)
    expect((await run(['--tool', 'pi', '--format', 'yaml'])).code).toBe(2)
    const broken = join(dir, 'not-a-db')
    writeFileSync(broken, 'not sqlite')
    const out: string[] = []
    const err: string[] = []
    const code = await runContextCli('context', ['deliver', '--tool', 'pi'], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      dbPath: broken,
      machine: 'test',
      statusUrl: null,
      fetch,
      now: () => new Date(),
      agentHub: { checkout: '', source: () => ({}) as never },
    })
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/^aico context deliver: .+\n$/)
    expect(out).toEqual([])
  })

  it('reports a missing computed block on stderr', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runContextCli('context', ['deliver', '--tool', 'pi', '--project', 'alpha'], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      dbPath,
      machine: 'test',
      statusUrl: null,
      fetch,
      now: () => new Date(DELIVERY_FIXTURE.now),
      agentHub: { checkout: '', source: () => ({}) as never },
      delivery: {
        env: {},
        toolUsage: async () => ({ error: 'st: not found' }),
        activity: async () => [],
      },
    })
    expect(code).toBe(0)
    expect(err.join('')).toBe('aico context deliver: no tool-usage: st: not found\n')
    expect(out.join('')).toContain('## Safety Rules')
  })
})

type Schema = {
  type?: string | string[]
  enum?: unknown[]
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, Schema>
  items?: Schema
  $ref?: string
  pattern?: string
  minimum?: number
}

/** The JSON Schema keywords the contract uses, checked; the problems found. */
function check(value: unknown, schema: Schema, defs: Record<string, Schema>, at = '$'): string[] {
  if (schema.$ref)
    return check(value, defs[schema.$ref.split('/').pop() as string] as Schema, defs, at)
  const kind =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value
  const types = schema.type === undefined ? [] : [schema.type].flat()
  if (types.length && !types.includes(kind)) return [`${at}: ${kind}, not ${types.join('|')}`]
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${String(value)} not in enum`]
  if (schema.pattern && !new RegExp(schema.pattern).test(String(value))) return [`${at}: pattern`]
  if (schema.minimum !== undefined && (value as number) < schema.minimum) return [`${at}: minimum`]
  if (Array.isArray(value) && schema.items)
    return value.flatMap((item, index) =>
      check(item, schema.items as Schema, defs, `${at}[${index}]`),
    )
  if (kind !== 'object') return []
  const object = value as Record<string, unknown>
  return [
    ...(schema.required ?? [])
      .filter((key) => !(key in object))
      .map((key) => `${at}.${key}: missing`),
    ...Object.keys(object).flatMap((key) => {
      const property = schema.properties?.[key]
      if (property) return check(object[key], property, defs, `${at}.${key}`)
      return schema.additionalProperties === false ? [`${at}.${key}: not allowed`] : []
    }),
  ]
}

describe('the delivery contract', () => {
  const schema = JSON.parse(
    readFileSync(
      new URL('../../../contracts/context-delivery.schema.json', import.meta.url),
      'utf8',
    ),
  ) as Schema & { $defs: Record<string, Schema> }

  it('every fixture delivery, cut ones included, is what the schema says', () => {
    const db = fixtureDb()
    for (const entry of DELIVERY_FIXTURE.cases) {
      const { request, settings } = fixtureRequest(entry)
      const delivery = JSON.parse(JSON.stringify(deliver(db, request, settings)))
      expect(check(delivery, schema, schema.$defs)).toEqual([])
    }
  })

  it('the schema catches a wrong delivery', () => {
    const wrong = { tool: 'emacs', hash: 'x', sections: [{ id: 1 }] }
    expect(check(wrong, schema, schema.$defs)).toEqual(
      expect.arrayContaining(['$.tool: emacs not in enum', '$.hash: pattern', '$.text: missing']),
    )
  })
})

describe('context delivery switch', () => {
  it('turns a tool on and lists the tools Tether delivers to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-switch-'))
    try {
      const out: string[] = []
      const io: ContextCliIo = {
        out: (text) => out.push(text),
        err: () => {},
        dbPath: join(dir, 'context.db'),
        machine: 'test',
        statusUrl: null,
        fetch,
        now: () => new Date(),
        agentHub: { checkout: '', source: () => ({}) as never },
      }
      expect(await runContextCli('context', ['delivery', 'codex', 'on'], io)).toBe(0)
      expect(await runContextCli('context', ['delivery', 'codex', 'maybe'], io)).toBe(2)
      expect(out.join('')).toBe(
        "Tether delivers Aico's context to: codex (the rest get Agent Hub's)\n",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('delivery edge cases', () => {
  const [entry] = DELIVERY_FIXTURE.cases as [(typeof DELIVERY_FIXTURE.cases)[number]]
  const { request } = fixtureRequest(entry)
  const budgeted = (budgetBytes: number): typeof DELIVERY => ({
    ...DELIVERY,
    tools: Object.fromEntries(
      Object.entries(DELIVERY.tools).map(([id, tool]) => [id, { ...tool, budgetBytes }]),
    ) as typeof DELIVERY.tools,
  })

  it('puts a cut section back when the cuts freed room for it', () => {
    const db = fixtureDb()
    const big = { ...request, toolUsage: 'x'.repeat(800) }
    const full = deliver(db, big, budgeted(100_000))
    const activity = full.sections.find((section) => section.id === 'activity')
    expect(activity).toBeDefined()
    // Cutting the activity alone does not fit; cutting the tool-usage block too frees more than needed.
    const tight = full.bytes - (activity?.bytes ?? 0) - 3
    const fitted = deliver(db, big, budgeted(tight))
    expect(fitted.cut.map((section) => section.id)).toEqual(['tool-usage'])
    expect(fitted.sections.map((section) => section.id)).toContain('activity')
    expect(fitted.bytes).toBeLessThanOrEqual(tight)
    // Render order is kept: the re-added activity sits before the (cut) tool-usage slot.
    const kinds = fitted.sections.map((section) => section.kind)
    expect(kinds.indexOf('activity')).toBe(kinds.length - 1)
  })

  it('cuts a hook delivery to the tool hook budget, and not a launch one', () => {
    const db = fixtureDb()
    const big = { ...request, toolUsage: 'x'.repeat(4000) }
    const settings = {
      ...DELIVERY,
      tools: { ...DELIVERY.tools, 'claude-code': { budgetBytes: 100_000, hookBudgetBytes: 1500 } },
    }
    const launch = deliver(db, { ...big, tool: 'claude-code' }, settings)
    const hook = deliver(db, { ...big, tool: 'claude-code', hook: true }, settings)
    expect(launch.sections.map((section) => section.id)).toContain('tool-usage')
    expect(hook.cut.map((section) => section.id)).toContain('tool-usage')
    expect(hook.budget).toBe(1500)
    expect(launch.budget).toBe(100_000)
    // A tool without a hook budget takes its whole budget in a hook.
    expect(deliver(db, { ...big, tool: 'codex', hook: true }, settings).budget).toBe(
      DELIVERY.tools.codex.budgetBytes,
    )
    expect(DELIVERY.tools['claude-code'].hookBudgetBytes).toBeLessThan(10_000)
  })

  it('skips a prompt or memory row whose JSON is unreadable and says so', () => {
    const db = fixtureDb()
    db.prepare(
      `INSERT INTO prompts (slug, name, content, kind, is_global, context_policy, updated_at)
       VALUES ('bad-null', 'Bad Null', 'x', 'rule', 1, 'null', ?), ('bad-text', 'Bad Text', 'x', 'rule', 1, '{oops', ?)`,
    ).run(DELIVERY_FIXTURE.now, DELIVERY_FIXTURE.now)
    db.prepare(
      `INSERT INTO memories (id, scope, scope_id, tier, content, triggers, applicability, created_at, updated_at)
       VALUES ('bad00000-0000-0000-0000-000000000000', 'global', '', 'mandate', 'broken', '[]', 'null', ?, ?)`,
    ).run(DELIVERY_FIXTURE.now, DELIVERY_FIXTURE.now)
    const delivery = deliver(db, request)
    expect(delivery.missing.map((gap) => gap.id).sort()).toEqual([
      'memory:bad00000-0000-0000-0000-000000000000',
      'prompt:bad-null',
      'prompt:bad-text',
    ])
    expect(delivery.text).toContain('## Safety Rules')
    expect(delivery.text).not.toContain('broken')
  })

  it('prunes the inventory by age, items with it', () => {
    const db = fixtureDb()
    const delivery = deliver(db, request)
    const now = new Date(DELIVERY_FIXTURE.now)
    const old = new Date(now.getTime() - (DELIVERY.keepDays + 1) * 86_400_000)
    recordDelivery(db, delivery, 'launch', old)
    recordDelivery(db, delivery, 'launch', new Date(old.getTime() + 86_400_000))
    expect(db.prepare('SELECT count(*) AS n FROM deliveries').get()).toEqual({ n: 2 })
    recordDelivery(db, delivery, 'launch', now)
    expect(db.prepare('SELECT count(*) AS n FROM deliveries').get()).toEqual({ n: 2 })
    const orphans = db
      .prepare(
        'SELECT count(*) AS n FROM delivery_items WHERE delivery_id NOT IN (SELECT id FROM deliveries)',
      )
      .get()
    expect(orphans).toEqual({ n: 0 })
  })

  it('gives a project outside the registry global context only', () => {
    const db = fixtureDb()
    const known = deliver(db, { ...request, project: 'alpha' })
    const folder = deliver(db, { ...request, project: 'some-folder' })
    expect(known.sections.map((s) => s.id)).toContain('prompt:alpha-policy')
    expect(folder.project).toBeNull()
    expect(folder.sections.map((s) => s.id)).not.toContain('prompt:alpha-policy')
    expect(folder.missing).toEqual([
      { id: 'project', reason: 'some-folder is not in the project registry; global context only' },
    ])
  })

  it("matches tool and role names the way Agent Hub's applicability does", () => {
    const db = fixtureDb()
    const policy = (applicability: object) => JSON.stringify({ scope: 'global', applicability })
    const add = (slug: string, applicability: object) =>
      db
        .prepare(
          `INSERT INTO prompts (slug, name, content, kind, is_global, context_policy, updated_at)
           VALUES (?, ?, 'body', 'rule', 1, ?, ?)`,
        )
        .run(slug, slug, policy(applicability), DELIVERY_FIXTURE.now)
    add('only-codex-tui', { consumer_surfaces: ['codex_tui'] })
    add('only-pi-mono', { consumer_surfaces: ['Pi_Mono'] })
    add('claude-cli', { consumer_surfaces: ['claude_cli'] })
    add('not-claude-tui', { exclude_consumer_surfaces: ['Claude TUI'] })
    add('for-role', { agent_slugs: ['implementation_agent'] })
    add('not-for-role', { exclude_agent_slugs: ['implementation_agent'] })
    const ids = (tool: string, role: string | null) =>
      deliver(db, { tool, role }).sections.map((section) => section.id)
    expect(ids('codex', null)).toContain('prompt:only-codex-tui')
    expect(ids('claude-code', null)).not.toContain('prompt:only-codex-tui')
    expect(ids('pi', null)).toContain('prompt:only-pi-mono')
    expect(ids('claude-code', null)).toContain('prompt:claude-cli')
    expect(ids('codex', null)).not.toContain('prompt:claude-cli')
    expect(ids('claude-code', null)).not.toContain('prompt:not-claude-tui')
    expect(ids('codex', 'implementation-agent')).toContain('prompt:for-role')
    expect(ids('codex', 'Implementation_Agent')).not.toContain('prompt:not-for-role')
    expect(ids('codex', null)).not.toContain('prompt:for-role')
  })
})
