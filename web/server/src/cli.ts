// The terminal launchers, run as `aico-web <command>` from web/scripts:
//
// - `tsession open|list|projects`: open, list and attach Tether sessions
//   (the Python backend's cli/session_broker.py, same flags and output).
// - `tclaude` / `tcodex [project|-l]`: pick a project (fzf), find its folder,
//   then `tsession open --attach` (the old scripts/lib/project-launcher.sh).
//
// Attaching is `tether sessions attach <id>`, which follows where the caller
// already is: outside tmux it attaches, inside the same tmux server it
// switches the client, inside a different one it nests after a notice.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TetherClient, TetherError, TetherUnavailable, tetherSocketPath } from 'tether/client'
import { type BrokerTarget, createBroker, normalizeWorkingDir } from './broker'
import { webDbPath } from './config'
import { WebStore } from './db'
import { createLifecycle, type Lifecycle } from './lifecycle'
import { HttpError } from './tether'

export const CLI_COMMANDS = ['tsession', 'tclaude', 'tcodex']

/** The tool each launcher opens. */
const LAUNCHER_TOOLS: Readonly<Record<string, string>> = {
  tclaude: 'claude-code',
  tcodex: 'codex',
}

export const EXIT_UNAVAILABLE = 69

export interface CliIo {
  out(text: string): void
  err(text: string): void
  env: NodeJS.ProcessEnv
  cwd: string
  /** Run a child on this terminal; its exit status. */
  run(argv: string[]): number
  /** fzf over `lines` (null when it could not run). */
  pick(lines: string[], prompt: string): string | null
  /** The repo checkout this CLI runs from (its workspaces root is a default). */
  repoRoot: string
}

class UsageError extends Error {}

// -- Python's output -------------------------------------------------------------

/** json.dumps: `", "` and `": "` separators, non-ASCII escaped. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'string')
    return JSON.stringify(value).replace(
      /[\u007f-￿]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${pyJson(key)}: ${pyJson(item)}`)
    .join(', ')}}`
}

// -- Arguments (argparse's shape and wording) ----------------------------------------

interface Flag {
  name: string
  value: boolean
  required?: boolean
  choices?: string[]
  metavar?: string
}

const COMMANDS: Record<string, Flag[]> = {
  open: [
    { name: 'tool', value: true, required: true },
    { name: 'project', value: true, required: true },
    { name: 'cwd', value: true },
    { name: 'attach', value: false },
    { name: 'print', value: false },
  ],
  list: [
    { name: 'tool', value: true },
    { name: 'format', value: true, choices: ['table', 'project-id', 'json'] },
  ],
  projects: [{ name: 'format', value: true, choices: ['tsv', 'json'] }],
}

const USAGE: Record<string, string> = {
  '': 'usage: tsession [-h] {open,list,projects} ...',
  open: 'usage: tsession open [-h] --tool TOOL --project PROJECT [--cwd CWD] [--attach]\n                     [--print]',
  list: 'usage: tsession list [-h] [--tool TOOL] [--format {table,project-id,json}]',
  projects: 'usage: tsession projects [-h] [--format {tsv,json}]',
}

const HELP: Record<string, string> = {
  '': `${USAGE['']}

Open and attach Tether sessions

positional arguments:
  {open,list,projects}
    open                Reuse or create a project tool session
    list                List running project tool sessions
    projects            List Tether's projects

options:
  -h, --help            show this help message and exit`,
  open: `${USAGE.open}

options:
  -h, --help         show this help message and exit
  --tool TOOL        Tool slug or alias, for example claude or codex
  --project PROJECT  Project id
  --cwd CWD          Working directory to match or start in
  --attach           Attach to (or switch to) the session
  --print            With --attach, print Tether's attach target instead`,
  list: `${USAGE.list}

options:
  -h, --help            show this help message and exit
  --tool TOOL           Filter to one tool slug
  --format {table,project-id,json}
                        Output format`,
  projects: `${USAGE.projects}

options:
  -h, --help           show this help message and exit
  --format {tsv,json}  Output format`,
}

class HelpShown extends Error {
  constructor(readonly text: string) {
    super(text)
  }
}

export interface TsessionArgs {
  command: string
  options: Record<string, string | boolean | undefined>
}

function usageError(command: string, message: string): UsageError {
  const prog = command ? `tsession ${command}` : 'tsession'
  return new UsageError(`${USAGE[command]}\n${prog}: error: ${message}`)
}

export function parseTsession(argv: string[]): TsessionArgs {
  const [command, ...rest] = argv
  if (command === '-h' || command === '--help') throw new HelpShown(HELP[''])
  if (command === undefined) throw usageError('', 'the following arguments are required: command')
  const flags = COMMANDS[command]
  if (!flags)
    throw usageError(
      '',
      `argument command: invalid choice: '${command}' (choose from open, list, projects)`,
    )
  const options: TsessionArgs['options'] = {}
  const unknown: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '-h' || arg === '--help') throw new HelpShown(HELP[command])
    const [key, inline] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s, 2) : [null, null]
    const flag = key === null ? undefined : flags.find((candidate) => candidate.name === key)
    if (!flag) {
      unknown.push(arg)
      continue
    }
    if (!flag.value) {
      options[flag.name] = true
      continue
    }
    if (inline === undefined) index += 1
    const value = inline ?? rest[index]
    if (value === undefined || (inline === undefined && value.startsWith('--')))
      throw usageError(command, `argument --${flag.name}: expected one argument`)
    if (flag.choices && !flag.choices.includes(value))
      throw usageError(
        command,
        `argument --${flag.name}: invalid choice: '${value}' (choose from ${flag.choices.join(', ')})`,
      )
    options[flag.name] = value
  }
  const missing = flags.filter((flag) => flag.required && options[flag.name] === undefined)
  if (missing.length)
    throw usageError(
      command,
      `the following arguments are required: ${missing.map((flag) => `--${flag.name}`).join(', ')}`,
    )
  if (unknown.length) throw usageError('', `unrecognized arguments: ${unknown.join(' ')}`)
  return { command, options }
}

// -- tsession --------------------------------------------------------------------

/** `tether sessions attach <id>` (`$TETHER_BIN` overrides the binary). */
export function tetherAttachArgv(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  printOnly = false,
): string[] {
  const binary = env.TETHER_BIN?.trim() || which('tether', env)
  if (!binary) throw new MissingTool('the tether CLI is not on PATH')
  return [binary, 'sessions', 'attach', sessionId, ...(printOnly ? ['--print'] : [])]
}

class MissingTool extends Error {}

function which(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

function expandCwd(value: string, io: CliIo): string {
  const home = io.env.HOME || homedir()
  const expanded =
    value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
  return normalizeWorkingDir(resolve(io.cwd, expanded)) as string
}

interface Project {
  id: string
  name: string
  root_path: string | null
  lifecycle: unknown
}

async function projects(life: Lifecycle): Promise<Project[]> {
  return (await life.tether.projects())
    .filter((project) => typeof project?.id === 'string' && project.id)
    .map((project) => ({
      id: project.id,
      name: project.name || project.id,
      root_path: project.root ?? null,
      lifecycle: (project as unknown as Record<string, unknown>).lifecycle ?? null,
    }))
}

async function projectsOrNone(life: Lifecycle): Promise<Project[]> {
  try {
    return await projects(life)
  } catch (error) {
    if (error instanceof TetherUnavailable || error instanceof TetherError) return []
    throw error
  }
}

const plain = (value: string) => !value.includes('\t') && !value.includes('\n')

async function openTarget(
  life: Lifecycle,
  io: CliIo,
  options: { tool: string; project: string; cwd?: string; attach?: boolean; print?: boolean },
): Promise<number> {
  // Resolved here, where '.' and '~' still mean the caller's: Tether only
  // takes an absolute folder, and reuse matching compares resolved paths.
  const workingDir = options.cwd ? expandCwd(options.cwd, io) : null
  const found = await createBroker(life).ensure({
    projectId: options.project,
    tool: options.tool,
    workingDir,
  })
  if (options.attach) return io.run(tetherAttachArgv(found.session_id, io.env, !!options.print))
  io.out(`${pyJson(found)}\n`)
  return 0
}

async function tsession(lifeOf: () => Lifecycle, io: CliIo, argv: string[]): Promise<number> {
  const { command, options } = parseTsession(argv)
  const life = lifeOf()
  if (command === 'open')
    return openTarget(life, io, {
      tool: options.tool as string,
      project: options.project as string,
      cwd: options.cwd as string | undefined,
      attach: options.attach === true,
      print: options.print === true,
    })
  if (command === 'list') {
    const targets = await createBroker(life).list((options.tool as string | undefined) ?? null)
    const format = (options.format as string | undefined) ?? 'table'
    if (format === 'json') io.out(`${pyJson(targets)}\n`)
    else if (format === 'project-id') {
      const ids = [...new Set(targets.map((target) => target.project_id))]
      if (ids.length) io.out(`${ids.join('\n')}\n`)
    } else if (!targets.length) io.out('No running project sessions.\n')
    else io.out(targets.map(tableRow).join(''))
    return 0
  }
  // projects: prints nothing (exit 0) while Tether is down.
  const found = await projectsOrNone(life)
  if (options.format === 'json') io.out(`${pyJson(found)}\n`)
  else
    io.out(
      found
        .filter((project) => plain(project.id) && plain(project.root_path ?? ''))
        .map((project) => `${project.id}\t${project.root_path ?? ''}\n`)
        .join(''),
    )
  return 0
}

const tableRow = (target: BrokerTarget) =>
  `${target.project_id}\t${target.mode}\t${target.session_id}\t${target.pane_name || '-'}\n`

// -- tclaude / tcodex --------------------------------------------------------------

const INDICATOR_DIRS = ['.claude', '.gemini', '.codex']
const INDICATOR_FILES = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'Makefile',
  'CMakeLists.txt',
]

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function looksLikeProject(dir: string): boolean {
  return (
    isDir(join(dir, '.git')) &&
    (INDICATOR_DIRS.some((name) => isDir(join(dir, name))) ||
      INDICATOR_FILES.some((name) => isFile(join(dir, name))))
  )
}

/** `$ST_WORKSPACES_ROOT`, else the folder holding `projects/` when this checkout sits in one. */
export function workspacesRoot(io: CliIo): string | null {
  if (io.env.ST_WORKSPACES_ROOT !== undefined) return io.env.ST_WORKSPACES_ROOT || null
  const parent = dirname(io.repoRoot)
  return basename(parent) === 'projects' ? dirname(parent) : null
}

function subdirectories(base: string): string[] {
  try {
    return readdirSync(base)
      .filter((name) => !name.startsWith('.') && isDir(join(base, name)))
      .sort()
  } catch {
    return []
  }
}

async function discoverProjects(life: Lifecycle, io: CliIo): Promise<string[]> {
  const seen = new Set<string>()
  const found: string[] = []
  for (const project of await projectsOrNone(life)) {
    if (!plain(project.id) || !project.root_path || !plain(project.root_path)) continue
    if (!looksLikeProject(project.root_path)) continue
    seen.add(project.id)
    found.push(project.id)
  }
  const workspaces = workspacesRoot(io)
  const bases = [...(workspaces ? [join(workspaces, 'projects')] : []), io.env.HOME || homedir()]
  for (const base of bases)
    for (const name of subdirectories(base))
      if (!seen.has(name) && looksLikeProject(join(base, name))) found.push(name)
  return found
}

async function projectDir(life: Lifecycle, io: CliIo, project: string): Promise<string | null> {
  const known = (await projectsOrNone(life)).find((item) => item.id === project)
  if (known?.root_path && plain(known.root_path) && isDir(known.root_path)) return known.root_path
  const workspaces = workspacesRoot(io)
  if (workspaces && isDir(join(workspaces, 'projects', project)))
    return join(workspaces, 'projects', project)
  const home = join(io.env.HOME || homedir(), project)
  return isDir(home) ? home : null
}

async function selectProject(life: Lifecycle, io: CliIo, tool: string): Promise<string | null> {
  let active = new Set<string>()
  try {
    active = new Set((await createBroker(life).list(tool)).map((target) => target.project_id))
  } catch {
    // No [active] marks while Tether is away.
  }
  const found = await discoverProjects(life, io)
  if (!found.length) {
    io.err('No projects found (need .git + project indicator)\n')
    return null
  }
  const selected = io.pick(
    found.map((project) => (active.has(project) ? `${project} [active]` : project)),
    'Select project: ',
  )
  if (!selected) {
    io.err('No project selected\n')
    return null
  }
  return selected.replace(/ \[active\]$/, '')
}

async function launch(life: Lifecycle, io: CliIo, tool: string, argv: string[]): Promise<number> {
  let selected = argv[0] ?? ''
  if (selected === '-l') return tsession(() => life, io, ['list', '--tool', tool])
  if (!selected) {
    const picked = await selectProject(life, io, tool)
    if (!picked) return 1
    selected = picked
  }
  const dir = await projectDir(life, io, selected)
  if (!dir) {
    io.err(`Project '${selected}' not found\n`)
    return 1
  }
  return openTarget(life, io, { tool, project: selected, cwd: dir, attach: true })
}

// -- Running ---------------------------------------------------------------------------

/**
 * Run one command; errors become tsession's messages and exit codes. `lifeOf`
 * opens the state only once the arguments are good (help touches nothing).
 */
export async function runCommand(
  lifeOf: () => Lifecycle,
  io: CliIo,
  command: string,
  argv: string[],
): Promise<number> {
  try {
    if (command === 'tsession') return await tsession(lifeOf, io, argv)
    return await launch(lifeOf(), io, LAUNCHER_TOOLS[command], argv)
  } catch (error) {
    if (error instanceof HelpShown) {
      io.out(`${error.text}\n`)
      return 0
    }
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`)
      return 2
    }
    const cause = error instanceof HttpError && error.cause ? error.cause : error
    if (cause instanceof TetherUnavailable) {
      io.err(`tsession: Tether is not reachable (${cause.message}). Is tether@default running?\n`)
      return EXIT_UNAVAILABLE
    }
    if (cause instanceof TetherError) {
      io.err(`tsession: Tether refused the request (${cause.code}).\n`)
      return 1
    }
    if (error instanceof MissingTool) {
      io.err(`tsession: ${error.message}.\n`)
      return EXIT_UNAVAILABLE
    }
    if (error instanceof HttpError) {
      io.err(`tsession: ${error.detail}.\n`)
      return 1
    }
    throw error
  }
}

function terminalIo(): CliIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    run: (argv) => {
      const child = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' })
      if (child.error) {
        process.stderr.write(`tsession: ${child.error.message}\n`)
        return 1
      }
      return child.status ?? 1
    },
    pick: (lines, prompt) => {
      const child = spawnSync('fzf', ['--height=10', '--reverse', `--prompt=${prompt}`], {
        input: `${lines.join('\n')}\n`,
        stdio: ['pipe', 'pipe', 'inherit'],
        encoding: 'utf8',
      })
      if (child.error) {
        process.stderr.write(`fzf: ${child.error.message}\n`)
        return null
      }
      return child.status === 0 ? child.stdout.replace(/\n$/, '') : null
    },
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  }
}

/** `aico-web tsession|tclaude|tcodex …` against the user's own Tether and the web app's state. */
export async function runCli(command: string, argv: string[]): Promise<number> {
  const env = process.env
  let life: Lifecycle | null = null
  const lifeOf = () => {
    life ??= createLifecycle({
      tether: new TetherClient(tetherSocketPath(env, process.getuid?.())),
      store: new WebStore(webDbPath(env)),
    })
    return life
  }
  try {
    return await runCommand(lifeOf, terminalIo(), command, argv)
  } finally {
    ;(life as Lifecycle | null)?.store.close()
  }
}
