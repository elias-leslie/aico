// Context delivery conformance: every adapter that takes Aico's delivery runs
// against the same fixture contexts (contracts/context-delivery-fixtures.json).
// Each case is delivered for each tool, its files are written, and its launch
// line runs through bash with a stand-in for the tool that records the argv and
// environment it was started with. What the tool would read from those must be
// the delivered text, byte for byte. A tool joins by declaring `contextDelivery`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { contextDbPath, DELIVERY, deliver, openContext, setDeliveryTool } from '@aico/context'
import { DELIVERY_FIXTURE, fixtureDb, fixtureRequest } from '@aico/context/delivery-fixture'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../../store'
import {
  bindCatalog,
  getSessionEntry,
  getWidget,
  insertWidget,
  listSessions,
  reserveRootRequest,
  rootRequestForWidget,
  setWidgetName,
  setWidgetProject,
} from '../catalog'
import type { TuiAdapter } from './adapters/contract'
import {
  deliveryDir,
  deliveryLaunch,
  forgetDelivery,
  lastDelivery,
  withContextDelivery,
} from './delivery'
import { launchLine } from './launch'
import { ADAPTERS, adapterOf, toolSpec } from './registry'
import type { TuiSpec } from './spec'

const root = mkdtempSync(join(tmpdir(), 'tether-delivery-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const recorder = join(root, 'record.mjs')
writeFileSync(
  recorder,
  'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid }))\n',
)

interface Started {
  argv: string[]
  env: Record<string, string>
  pid: number
}

/** Run a launch line with the tool swapped for the recorder. */
function start(spec: TuiSpec): Started {
  const line = launchLine({ ...spec, command: [process.execPath, recorder] }) as string
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }
  return JSON.parse(
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], { encoding: 'utf8', env }),
  )
}

const after = (argv: string[], flag: string): string[] =>
  argv.flatMap((word, index) => (word === flag ? [argv[index + 1] as string] : []))

/** Codex's own reading of a `-c key=value` override: the value is TOML. */
function tomlValue(assignment: string, key: string): string {
  const script = `import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())[${JSON.stringify(key)}]))`
  return JSON.parse(
    execFileSync('python3', ['-I', '-c', script], { input: assignment, encoding: 'utf8' }),
  )
}

/** What each kind of tool reads from the way it was started. */
function read(how: NonNullable<TuiSpec['contextDelivery']>, started: Started, dir = ''): string[] {
  if (how.kind === 'claude-md') {
    const dirs = after(started.argv, how.arguments[0] as string)
    if (dirs.length)
      for (const [key, value] of Object.entries(how.env)) expect(started.env[key]).toBe(value)
    return dirs.map((dir) => readFileSync(join(dir, 'CLAUDE.md'), 'utf8'))
  }
  if (how.kind === 'hook') {
    // Nothing goes on the command line: agy would work in an added folder. The hook reads the file.
    expect(started.argv).not.toContain('--add-dir')
    return started.env.AICO_CONTEXT_DELIVERED
      ? [dir]
          .filter((d) => existsSync(join(d, how.file)))
          .map((d) => readFileSync(join(d, how.file), 'utf8'))
      : []
  }
  if (how.kind === 'config')
    return after(started.argv, how.arguments[0] as string)
      .filter((value) => value.startsWith(`${how.key}=`))
      .map((value) => tomlValue(value, how.key))
  // Pi appends a file's contents when the value names one, else the value itself.
  return after(started.argv, how.arguments[0] as string).map((value) =>
    existsSync(value) ? readFileSync(value, 'utf8') : value,
  )
}

const delivering = ADAPTERS.filter((adapter) => adapter.spec.contextDelivery)

it('every tool context.db can deliver to has an adapter that takes it, and only those', () => {
  expect(delivering.map((adapter) => adapter.id).sort()).toEqual(Object.keys(DELIVERY.tools).sort())
})

describe.each(delivering.map((adapter) => [adapter.id, adapter] as const))('%s', (id, adapter) => {
  const spec = toolSpec({ ...adapter.seed, id, command: '', createdAt: 0, updatedAt: 0 })
  const how = spec.contextDelivery as NonNullable<TuiSpec['contextDelivery']>
  const db = fixtureDb()

  for (const entry of DELIVERY_FIXTURE.cases)
    it(`reads exactly what was delivered: ${entry.name}`, () => {
      const { request, settings } = fixtureRequest(entry)
      const delivery = deliver(db, { ...request, tool: id }, settings)
      const dir = join(root, id, String(DELIVERY_FIXTURE.cases.indexOf(entry)))
      mkdirSync(dir, { recursive: true })
      const { files, delivered } = deliveryLaunch(how, dir, delivery.text, delivery.hash)
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      const started = start({ ...spec, deliveredContext: delivered })
      expect(started.env.AICO_CONTEXT_DELIVERED).toBe(delivery.hash)
      // The marker names the started agent itself, so a session it starts is not covered.
      expect(started.env.AICO_CONTEXT_PID).toBe(String(started.pid))
      expect(read(how, started, dir)).toEqual(delivery.text ? [delivery.text] : [])
    })

  // agy takes no chosen instructions.
  it.runIf(Boolean(spec.instructions))(
    'reads the delivery and the chosen instructions, each once',
    () => {
      const [entry] = DELIVERY_FIXTURE.cases
      const { request, settings } = fixtureRequest(entry as (typeof DELIVERY_FIXTURE.cases)[number])
      const delivery = deliver(db, { ...request, tool: id }, settings)
      const dir = join(root, id, 'chosen')
      mkdirSync(dir, { recursive: true })
      const chosenFile = join(dir, 'chosen.md')
      const chosen = 'Review only.\nQuote \'this\' and "that" and $HOME literally.'
      writeFileSync(chosenFile, chosen)
      const merged = how.kind === 'config' && how.key === spec.instructions?.key
      const text = merged ? `${delivery.text}\n\n${chosen}` : delivery.text
      const { files, delivered } = deliveryLaunch(how, dir, text, delivery.hash, merged)
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      const started = start({
        ...spec,
        chosenInstructions: { file: chosenFile, label: 'review@00000000' },
        deliveredContext: delivered,
      })
      const flag = spec.instructions?.arguments[0] as string
      const values = after(started.argv, flag)
      if (merged) {
        expect(read(how, started, dir)).toEqual([text])
        expect(values).toHaveLength(1)
      } else {
        // Pi reads both from its one flag; Claude Code the delivery from its CLAUDE.md.
        const seen = [...read(how, started, dir), ...(how.kind === 'file' ? [] : values)]
        expect(seen.sort()).toEqual([delivery.text, chosen].sort())
      }
    },
  )
})

it('a launch with no delivery adds nothing', () => {
  for (const adapter of delivering) {
    const spec = toolSpec({
      ...adapter.seed,
      id: adapter.id,
      command: '',
      createdAt: 0,
      updatedAt: 0,
    })
    const started = start(spec)
    expect(started.env.AICO_CONTEXT_DELIVERED).toBeUndefined()
    expect(started.argv).toEqual([])
  }
})

describe('a tool whose limits are its hook', () => {
  const adapter = ADAPTERS.find((a) => a.spec.contextDelivery?.kind === 'hook')
  const how = adapter?.spec.contextDelivery as Extract<
    NonNullable<TuiSpec['contextDelivery']>,
    { kind: 'hook' }
  >
  const spec = { command: ['agy', ...how.needsHook], slug: 'agy', contextDelivery: how } as TuiSpec
  const home = join(root, 'hook-home')
  const deps = {
    env: { HOME: home, AICO_DATA_DIR: join(home, 'none') },
    now: () => new Date(),
    toolUsage: async () => ({ ok: false }),
    catalog: {
      widget: () => undefined,
      hasEntry: () => false,
      workRole: () => null,
      sessions: () => [],
    },
  } as unknown as Parameters<typeof withContextDelivery>[2]

  it('without the hook, loses the skip-permissions flag and asks', async () => {
    rmSync(home, { recursive: true, force: true })
    expect((await withContextDelivery(spec, 'abcd1234', deps)).command).toEqual(['agy'])
    mkdirSync(dirname(join(home, how.hooks)), { recursive: true })
    writeFileSync(join(home, how.hooks), '{"mine":{}}')
    expect((await withContextDelivery(spec, 'abcd1234', deps)).command).toEqual(['agy'])
  })

  it('with the hook listed but its program gone, loses the flag too', async () => {
    rmSync(join(home, how.binary), { force: true })
    mkdirSync(dirname(join(home, how.hooks)), { recursive: true })
    writeFileSync(join(home, how.hooks), `{"aico":{"PreToolUse":"${how.marker}"}}`)
    expect((await withContextDelivery(spec, 'abcd1234', deps)).command).toEqual(['agy'])
  })

  it('works in the project, not the scratch folder the tool picks on its own', async () => {
    const inProject = {
      ...deps,
      catalog: { ...deps.catalog, widget: () => ({ projectRoot: '/srv/a project' }) },
    } as unknown as typeof deps
    const { command } = await withContextDelivery(spec, 'abcd1234', inProject)
    expect(command.slice(-2)).toEqual([...how.workspace, "'/srv/a project'"])
  })

  it('with the hook, keeps it', async () => {
    mkdirSync(dirname(join(home, how.hooks)), { recursive: true })
    writeFileSync(join(home, how.hooks), `{"aico":{"PreToolUse":"${how.marker}"}}`)
    mkdirSync(dirname(join(home, how.binary)), { recursive: true })
    writeFileSync(join(home, how.binary), '')
    expect((await withContextDelivery(spec, 'abcd1234', deps)).command).toEqual(spec.command)
  })
})

describe('withContextDelivery', () => {
  const store = new Store(':memory:')
  const env = { HOME: root, AICO_DATA_DIR: join(root, 'data') }
  const deps = {
    env,
    now: () => new Date(DELIVERY_FIXTURE.now),
    toolUsage: async () => DELIVERY_FIXTURE.toolUsage,
    catalog: {
      widget: getWidget,
      hasEntry: (id: string) => getSessionEntry(id) !== null,
      workRole: (id: string) => rootRequestForWidget(id)?.workRole ?? null,
      sessions: listSessions,
    },
  }
  beforeAll(() => {
    bindCatalog(store.db)
    mkdirSync(env.AICO_DATA_DIR, { recursive: true })
    fixtureDb(contextDbPath(env.AICO_DATA_DIR)).close()
    insertWidget('e0000001', 'codex', Date.parse('2026-11-03T11:00:00Z'))
    setWidgetProject('e0000001', 'alpha', root)
    insertWidget('e0000002', 'pi', Date.parse('2026-11-03T11:30:00Z'))
    setWidgetProject('e0000002', 'alpha', root)
    setWidgetName('e0000002', 'Alpha review')
  })
  afterAll(() => store.close())
  const codex = () =>
    toolSpec({
      ...(adapterOf('codex') as TuiAdapter).seed,
      id: 'codex',
      command: '',
      createdAt: 0,
      updatedAt: 0,
    })
  const switched = (on: boolean) => {
    const db = openContext(contextDbPath(env.AICO_DATA_DIR))
    setDeliveryTool(db, 'codex', on)
    db.close()
  }

  it('leaves the launch alone while the tool is switched off', async () => {
    switched(false)
    const spec = codex()
    expect(await withContextDelivery(spec, 'e0000001', deps)).toBe(spec)
    expect(existsSync(deliveryDir('e0000001', env))).toBe(false)
  })

  it('writes the delivery, keeps its inventory and says so in the launch', async () => {
    switched(true)
    const spec = await withContextDelivery(codex(), 'e0000001', deps)
    const delivered = spec.deliveredContext
    const started = start(spec)
    const [text] = read(spec.contextDelivery as NonNullable<TuiSpec['contextDelivery']>, started)
    expect(text).toContain('## Alpha Policy')
    expect(text).toContain('- [30 min ago] pi: Alpha review')
    expect(started.env.AICO_CONTEXT_DELIVERED).toBe(delivered?.hash)
    expect(lastDelivery('e0000001', env)).toMatchObject({ tool: 'codex', hash: delivered?.hash })
    const db = openContext(contextDbPath(env.AICO_DATA_DIR))
    const row = db.prepare('SELECT channel, project, session, bytes FROM deliveries').get()
    db.close()
    expect(row).toMatchObject({ channel: 'launch', project: 'alpha', bytes: delivered?.bytes })
    forgetDelivery('e0000001', env)
    expect(lastDelivery('e0000001', env)).toBeNull()
  })

  it('launches as it was when context.db cannot be read', async () => {
    const spec = codex()
    const broken = { ...deps, env: { HOME: root, AICO_DATA_DIR: join(root, 'nowhere') } }
    expect(await withContextDelivery(spec, 'e0000001', broken)).toBe(spec)
  })
  it('keeps explicit Codex instructions for a blank-slate role in a normal workspace', async () => {
    switched(true)
    reserveRootRequest(
      {
        requestId: 'blank-role-proof',
        digest: 'test',
        widgetId: 'e0000003',
        logicalSessionId: 'logical-proof',
        role: 'lane',
        workRole: 'blank-proof',
        leadRootReference: null,
        facetCapsuleRef: null,
        createdAt: deps.now().getTime(),
        origin: 'aico',
      },
      'codex',
      'alpha',
      root,
    )
    const db = openContext(contextDbPath(env.AICO_DATA_DIR))
    db.prepare(
      "INSERT INTO roles (name, label, context, position, updated_at) VALUES ('blank-proof', 'Blank proof', 'blank-slate', 99, ?)",
    ).run(deps.now().toISOString())
    const chosenFile = join(root, 'explicit-proof.md')
    const chosen = 'Review only. Do not modify files.'
    writeFileSync(chosenFile, chosen)
    try {
      const spec = await withContextDelivery(
        { ...codex(), chosenInstructions: { file: chosenFile, label: 'proof' } },
        'e0000003',
        deps,
      )
      const started = start(spec)
      expect(
        read(spec.contextDelivery as NonNullable<TuiSpec['contextDelivery']>, started),
      ).toEqual([chosen])
      const items = db
        .prepare('SELECT item FROM delivery_items WHERE item = ? AND cut = 0')
        .all(`file:${chosenFile}`)
      expect(items).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
