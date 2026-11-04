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

  function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
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
      agentHub: {
        checkout: '/nowhere',
        source: () => {
          throw new Error('not asked')
        },
        route: () => ({ error: 'not asked' }),
      },
      delivery: {
        env,
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

  it('says nothing in a session the launch already delivered to, unless forced', async () => {
    const args = ['--tool', 'codex', '--project', 'alpha', '--format', 'codex']
    for (const env of [
      { AICO_CONTEXT_DELIVERED: 'abc' },
      { AGENT_HUB_CONTEXT_PREINJECTED_HASH: 'abc' },
    ])
      expect(await run(args, env)).toEqual({ code: 0, out: '', err: '' })
    const forced = await run([...args, '--force'], { AICO_CONTEXT_DELIVERED: 'abc' })
    expect(forced.out).toContain('additionalContext')
  })

  it('prints nothing for a Blank Slate role', async () => {
    const result = await run([
      '--tool',
      'pi',
      '--project',
      'alpha',
      '--role',
      'testing',
      '--format',
      'pi',
    ])
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
      agentHub: { checkout: '', source: () => ({}) as never, route: () => ({ error: '' }) },
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
      agentHub: { checkout: '', source: () => ({}) as never, route: () => ({ error: '' }) },
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
        agentHub: { checkout: '', source: () => ({}) as never, route: () => ({ error: '' }) },
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
