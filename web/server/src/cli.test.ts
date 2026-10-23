import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TetherClient } from 'tether/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBroker } from './broker'
import { type CliIo, EXIT_UNAVAILABLE, pyJson, runCommand, tetherAttachArgv } from './cli'
import { WebStore } from './db'
import { createLifecycle, type Lifecycle } from './lifecycle'
import { FakeTether } from './testing'

let tether: FakeTether
let store: WebStore
let life: Lifecycle
let top: string

function fakeIo(fields: Partial<CliIo> = {}) {
  const io = {
    stdout: '',
    stderr: '',
    runs: [] as string[][],
    picks: [] as string[][],
    out(text: string) {
      io.stdout += text
    },
    err(text: string) {
      io.stderr += text
    },
    env: { TETHER_BIN: '/opt/tether', HOME: join(top, 'home'), ST_WORKSPACES_ROOT: '' },
    cwd: top,
    run(argv: string[]) {
      io.runs.push(argv)
      return 3
    },
    pick(lines: string[]) {
      io.picks.push(lines)
      return lines[0] ?? null
    },
    repoRoot: join(top, 'repo'),
    ...fields,
  }
  return io
}

/** A folder tclaude/tcodex count as a project: .git plus an indicator. */
function project(path: string): string {
  mkdirSync(join(path, '.git'), { recursive: true })
  writeFileSync(join(path, 'package.json'), '{}')
  return path
}

const run = (io: CliIo, command: string, ...argv: string[]) =>
  runCommand(() => life, io, command, argv)
const down = () => () =>
  createLifecycle({ tether: new TetherClient(join(top, 'none.sock')), store })

beforeEach(() => {
  tether = new FakeTether()
  store = new WebStore(':memory:')
  life = createLifecycle({ tether: tether.client, store })
  top = realpathSync(mkdtempSync(join(tmpdir(), 'aico-cli-')))
  mkdirSync(join(top, 'home'))
})

afterEach(() => {
  store.close()
  rmSync(top, { recursive: true, force: true })
})

describe('broker', () => {
  it('creates a project tab with a shell and the agent when none exists, then reuses it', async () => {
    const broker = createBroker(life)
    const made = await broker.ensure({ projectId: 'aico', tool: 'cc', workingDir: top })
    expect(made).toMatchObject({
      project_id: 'aico',
      mode: 'claude',
      pane_name: 'Aico',
      working_dir: top,
      created: true,
      started: false,
    })
    expect([...tether.sessions.values()].map((session) => session.tool).sort()).toEqual([
      'claude',
      'shell',
    ])
    expect(store.allProjectSettings().get('aico')).toMatchObject({ active_mode: 'claude' })
    const again = await broker.ensure({ projectId: 'aico', tool: 'claude', workingDir: top })
    expect(again).toMatchObject({ session_id: made.session_id, created: false })
    expect(tether.sessions.size).toBe(2)
  })

  it('reuses only a session in the same folder, however it is spelled', async () => {
    const broker = createBroker(life)
    const first = await broker.ensure({ projectId: 'aico', tool: 'claude', workingDir: top })
    expect(
      await broker.ensure({ projectId: 'aico', tool: 'claude', workingDir: `${top}/./` }),
    ).toMatchObject({ session_id: first.session_id })
    const other = await broker.ensure({
      projectId: 'aico',
      tool: 'claude',
      workingDir: join(top, 'home'),
    })
    expect(other).toMatchObject({ created: true, pane_name: 'Aico [2]' })
  })

  it("respawns a reused agent that isn't running", async () => {
    const stopped = tether.add({ tool: 'claude', projectId: 'aico', status: 'uncertain' })
    const found = await createBroker(life).ensure({
      projectId: 'aico',
      tool: 'claude',
      workingDir: null,
    })
    expect(found).toMatchObject({ session_id: stopped.id, created: false, started: true })
    expect(tether.callsOf('request').map((call) => call[1])).toContain(
      `/v1/sessions/${stopped.id}/respawn`,
    )
  })

  it('lists running project agents: no shells, no project-less sessions, one tool on request', async () => {
    tether.add({ tool: 'shell', projectId: 'aico' })
    tether.add({ tool: 'claude', projectId: null })
    const claude = tether.add({ tool: 'claude', projectId: 'aico' })
    const codex = tether.add({ tool: 'codex', projectId: 'aico' })
    tether.add({ tool: 'codex', projectId: 'aico', status: 'exited' as never })
    const broker = createBroker(life)
    expect((await broker.list()).map((target) => target.session_id)).toEqual([claude.id, codex.id])
    expect((await broker.list('cc')).map((target) => target.session_id)).toEqual([claude.id])
  })
})

describe('tsession', () => {
  it('prints the target as Python printed it', async () => {
    const io = fakeIo()
    expect(await run(io, 'tsession', 'open', '--tool', 'claude', '--project', 'aico')).toBe(0)
    const target = JSON.parse(io.stdout)
    expect(Object.keys(target)).toEqual([
      'project_id',
      'mode',
      'pane_id',
      'pane_name',
      'session_id',
      'tmux_session_name',
      'tmux_socket',
      'working_dir',
      'created',
      'started',
    ])
    expect(io.stdout).toMatch(/^\{"project_id": "aico", "mode": "claude", /)
    expect(pyJson({ name: 'Résumé 😀', n: [1, null, true] })).toBe(
      '{"name": "R\\u00e9sum\\u00e9 \\ud83d\\ude00", "n": [1, null, true]}',
    )
  })

  it("resolves '.' and '~/x' for the caller", async () => {
    mkdirSync(join(top, 'home', 'x'))
    const io = fakeIo()
    await run(io, 'tsession', 'open', '--tool', 'claude', '--project', 'aico', '--cwd', '.')
    await run(io, 'tsession', 'open', '--tool', 'claude', '--project', 'aico', '--cwd', '~/x')
    const roots = [...tether.sessions.values()]
      .filter((session) => session.tool === 'claude')
      .map((session) => session.projectRoot)
    expect(roots).toEqual([top, join(top, 'home', 'x')])
  })

  it("attaches through Tether's CLI and passes its exit status on", async () => {
    const io = fakeIo()
    const args = ['open', '--tool', 'claude', '--project', 'aico', '--attach', '--print']
    expect(await run(io, 'tsession', ...args)).toBe(3)
    const id = [...tether.sessions.values()].find((session) => session.tool === 'claude')?.id
    expect(io.runs).toEqual([['/opt/tether', 'sessions', 'attach', id, '--print']])
    expect(tetherAttachArgv('a0000001', { TETHER_BIN: '/opt/tether' })).toEqual([
      '/opt/tether',
      'sessions',
      'attach',
      'a0000001',
    ])
    const missing = fakeIo({ env: { PATH: '/nonexistent' } })
    expect(await run(missing, 'tsession', ...args)).toBe(EXIT_UNAVAILABLE)
    expect(missing.stderr).toContain('tether CLI')
  })

  it('lists as a table, project ids or nothing', async () => {
    const empty = fakeIo()
    await run(empty, 'tsession', 'list')
    expect(empty.stdout).toBe('No running project sessions.\n')
    const first = tether.add({ tool: 'claude', projectId: 'aico' })
    tether.add({ tool: 'claude', projectId: 'aico' })
    tether.add({ tool: 'claude', projectId: 'other' })
    const ids = fakeIo()
    await run(ids, 'tsession', 'list', '--tool', 'claude', '--format', 'project-id')
    expect(ids.stdout).toBe('aico\nother\n')
    const table = fakeIo()
    await run(table, 'tsession', 'list')
    expect(table.stdout.split('\n')[0]).toBe(`aico\tclaude\t${first.id}\t-`)
  })

  it("prints Tether's projects as TSV, leaving out unsafe ones, and nothing while it is down", async () => {
    tether.projectList = [
      { id: 'summitflow', name: 'SummitFlow', root: '/srv/summitflow' },
      { id: 'bad', name: 'Bad', root: '/srv/with\ttab' },
    ]
    const io = fakeIo()
    expect(await run(io, 'tsession', 'projects', '--format', 'tsv')).toBe(0)
    expect(io.stdout).toBe('summitflow\t/srv/summitflow\n')
    const quiet = fakeIo()
    expect(await runCommand(down(), quiet, 'tsession', ['projects'])).toBe(0)
    expect(quiet.stdout).toBe('')
  })

  it('reports Tether down and bad arguments as tsession did', async () => {
    const io = fakeIo()
    const args = ['open', '--tool', 'codex', '--project', 'x']
    expect(await runCommand(down(), io, 'tsession', args)).toBe(EXIT_UNAVAILABLE)
    expect(io.stderr).toContain('Tether is not reachable')
    const bogus = fakeIo()
    expect(await run(bogus, 'tsession', 'bogus')).toBe(2)
    expect(bogus.stderr).toBe(
      "usage: tsession [-h] {open,list,projects} ...\ntsession: error: argument command: invalid choice: 'bogus' (choose from open, list, projects)\n",
    )
    const missing = fakeIo()
    expect(await run(missing, 'tsession', 'open')).toBe(2)
    expect(missing.stderr).toContain(
      'tsession open: error: the following arguments are required: --tool, --project',
    )
    const disabled = fakeIo()
    expect(await run(disabled, 'tsession', ...args)).toBe(1)
    expect(disabled.stderr).toBe("tsession: Agent tool 'Codex' is disabled.\n")
  })
})

describe('tclaude and tcodex', () => {
  it("opens the project's Tether root and attaches through tsession", async () => {
    const root = project(join(top, 'work', 'aico'))
    tether.projectList = [
      { id: 'other', name: 'Other', root: '/nowhere' },
      { id: 'aico', name: 'Aico', root },
    ]
    tether.tools.push({ slug: 'claude-code', name: 'Claude Code', enabled: true })
    const io = fakeIo()
    expect(await run(io, 'tclaude', 'aico')).toBe(3)
    const session = [...tether.sessions.values()].find((item) => item.tool === 'claude-code')
    expect(session?.projectRoot).toBe(root)
    expect(io.runs).toEqual([['/opt/tether', 'sessions', 'attach', session?.id]])
  })

  it('falls back to a home checkout and reports unknown projects', async () => {
    tether.projectList = []
    tether.tools[2].enabled = true
    const solo = project(join(top, 'home', 'solo'))
    const io = fakeIo()
    expect(await run(io, 'tcodex', 'solo')).toBe(3)
    expect([...tether.sessions.values()].find((item) => item.tool === 'codex')?.projectRoot).toBe(
      solo,
    )
    const ghost = fakeIo()
    expect(await run(ghost, 'tcodex', 'ghost')).toBe(1)
    expect(ghost.stderr).toBe("Project 'ghost' not found\n")
    expect(ghost.runs).toEqual([])
  })

  it('offers discovered projects, marking active ones, and lists with -l', async () => {
    tether.tools[2].enabled = true
    const root = project(join(top, 'work', 'aico'))
    tether.projectList = [{ id: 'aico', name: 'Aico', root }]
    project(join(top, 'home', 'solo'))
    mkdirSync(join(top, 'home', 'plain'))
    tether.add({ tool: 'codex', projectId: 'aico', projectRoot: root })
    const io = fakeIo()
    expect(await run(io, 'tcodex')).toBe(3)
    expect(io.picks).toEqual([['aico [active]', 'solo']])
    const listed = fakeIo()
    await run(listed, 'tcodex', '-l')
    expect(listed.stdout).toMatch(/^aico\tcodex\t/)
  })
})
