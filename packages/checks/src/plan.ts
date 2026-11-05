// What a check runs: the repo's .st-check.toml [native] stages plus its named legacy tools
// (`native.legacy_tools`: ruff, ty, pytest, Vitest, Biome, tsc and the security scanners), as
// steps for the quick lane (commit) or the full gate. Repos without a [native] section
// retain the standard legacy gate, selected according to their applicable inputs.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { matches } from './git'
import { parseToml, type TomlTable } from './toml'

export type Lane = 'quick' | 'full'

export interface StageDecl {
  id: string
  argv: string[]
  cwd: string
  kind: 'check' | 'test'
  coverage: 'full' | 'focused'
  required: boolean
  applicable: boolean
  reason: string
  quick: boolean
  quickPaths: string[]
  inputs: string[]
  exclude: string[]
  coveredBy?: string
  timeoutS: number
  /** What proves a test stage ran its tests (format text, junit, json or go-test-json). */
  evidence?: Evidence
}

export interface Evidence {
  format: 'text' | 'junit' | 'json' | 'go-test-json'
  source: 'file' | 'stdout' | 'combined'
  path?: string
  success_pattern?: string
  failure_pattern?: string
  executed_pattern?: string
  not_applicable_tests?: Record<string, string>
}

export interface Config {
  root: string
  stages: StageDecl[]
  legacy: string[]
  /** No [native] declaration: retain the standard gate and its applicability rules. */
  legacyDefault: boolean
  /** Local acceptance fixture, interpreted only in the committed acceptance tree. */
  acceptance?: TomlTable
  /** native.paths: project-local tool dirs, first on a stage's PATH. */
  paths: string[]
  /** native.tools: names linked onto a stage's PATH. */
  tools: Record<string, string>
  environment: Record<string, string>
  /** [paths]: where a legacy tool's binary lives (project-relative dir). */
  toolPaths: Record<string, string>
  pytestWorkers?: number
  /** Focused pytest runs add --no-cov unless [pytest] no_cov = false (no pytest-cov installed). */
  pytestNoCov: boolean
  /** Ignored runtime dirs an acceptance worktree links in (node_modules, venvs). */
  environmentInputs: string[]
  /** Hash of the config text: part of every reuse key. */
  digest: string
}

export class ConfigError extends Error {}

/** The tools this package runs; `security` is gitleaks plus osv plus semgrep. */
export const LEGACY = [
  'ruff',
  'types',
  'pytest',
  'vitest',
  'biome',
  'tsc',
  'security',
  'gitleaks',
  'osv',
  'semgrep',
  'govulncheck',
  'shellcheck',
  'actionlint',
] as const

const DEFAULT_GATE = ['ruff', 'types', 'pytest', 'biome', 'tsc', 'vitest', 'security']

const strings = (value: unknown, what: string): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new ConfigError(`${what} must be a list of strings`)
  return value as string[]
}

const record = (value: unknown, what: string): Record<string, string> => {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ConfigError(`${what} must be a table of strings`)
  for (const [key, item] of Object.entries(value))
    if (typeof item !== 'string') throw new ConfigError(`${what}.${key} must be a string`)
  return value as Record<string, string>
}

function evidence(id: string, raw: unknown): Evidence | undefined {
  if (raw === undefined) return undefined
  const value = raw as Record<string, unknown>
  if (!['text', 'junit', 'json', 'go-test-json'].includes(value.format as string))
    throw new ConfigError(`${id}: unsupported evidence format`)
  const source = (value.source as string | undefined) ?? 'file'
  if (!['file', 'stdout', 'combined'].includes(source))
    throw new ConfigError(`${id}: evidence.source is file, stdout or combined`)
  if (source === 'file' && typeof value.path !== 'string')
    throw new ConfigError(`${id}: file evidence needs a path`)
  return { ...(value as unknown as Evidence), source: source as Evidence['source'] }
}

function stage(raw: TomlTable, seen: Set<string>): StageDecl {
  const id = raw.id
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) || seen.has(id))
    throw new ConfigError('native stage ids must be unique identifiers')
  const argv = strings(raw.argv, `${id}.argv`)
  if (!argv.length) throw new ConfigError(`${id}: argv is empty`)
  const coverage = raw.coverage
  if (coverage !== 'full' && coverage !== 'focused')
    throw new ConfigError(`${id}: coverage is full or focused`)
  const applicable = raw.applicable !== false
  return {
    id,
    argv,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '.',
    kind: raw.kind === 'test' ? 'test' : 'check',
    coverage,
    required: raw.required !== false,
    applicable,
    reason: typeof raw.reason === 'string' ? raw.reason : 'declared_not_applicable',
    quick: raw.quick === true,
    quickPaths: strings(raw.quick_paths, `${id}.quick_paths`),
    inputs: strings(raw.inputs, `${id}.inputs`),
    exclude: strings(raw.exclude, `${id}.exclude`),
    coveredBy: typeof raw.covered_by === 'string' ? raw.covered_by : undefined,
    timeoutS: typeof raw.timeout_seconds === 'number' ? raw.timeout_seconds : 600,
    evidence: evidence(id, raw.evidence),
  }
}

/** The repo's declared gate, or the standard gate when it has no native declaration. */
export function loadConfig(root: string): Config | { unsupported: string } {
  const file = join(root, '.st-check.toml')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const data = parseToml(text)
  const legacyDefault = data.native === undefined
  const native = (data.native ?? {}) as TomlTable
  const legacy = strings(
    native.legacy_tools ??
      (legacyDefault ? DEFAULT_GATE : ['ruff', 'types', 'biome', 'tsc', 'security']),
    'native.legacy_tools',
  )
  const unknown = legacy.filter((tool) => !(LEGACY as readonly string[]).includes(tool))
  if (unknown.length) return { unsupported: `legacy tools ${unknown.join(', ')}` }
  const seen = new Set<string>()
  const stages: StageDecl[] = []
  for (const raw of (native.stages as TomlTable[] | undefined) ?? []) {
    stages.push(stage(raw, seen))
    seen.add(stages[stages.length - 1].id)
  }
  const pytest = data.pytest as TomlTable | undefined
  const toolPaths = record(data.paths, 'paths')
  const nativePaths = strings(native.paths, 'native.paths')
  const tools = record(native.tools, 'native.tools')
  const nativeExecutables = [
    ...nativePaths,
    ...Object.values(tools),
    ...stages.map((s) => s.argv[0]),
  ].filter((path) => !posix.isAbsolute(path) && !path.startsWith('~/'))
  const venvs = [...Object.values(toolPaths), ...nativeExecutables]
    .map((dir) => /^(.*?\.venv)(?:\/|$)/.exec(dir)?.[1])
    .filter((dir): dir is string => !!dir)
  return {
    root,
    stages,
    legacy,
    legacyDefault,
    acceptance: data.acceptance as TomlTable | undefined,
    paths: nativePaths,
    tools,
    environment: record(native.environment, 'native.environment'),
    toolPaths,
    pytestWorkers: typeof pytest?.workers === 'number' ? pytest.workers : undefined,
    pytestNoCov: pytest?.no_cov !== false,
    environmentInputs: [
      ...new Set([
        ...strings(native.environment_inputs, 'native.environment_inputs'),
        ...(legacyDefault ? ['node_modules', '.venv', 'venv'] : []),
        ...venvs,
      ]),
    ],
    digest: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
}

/** One thing to run. `env: 'stage'` is a declared stage's clean environment; 'user' the caller's. */
export interface Step {
  id: string
  argv: string[]
  /** Project-relative. */
  cwd: string
  env: 'stage' | 'user'
  timeoutS: number
  required: boolean
  /** Declared inputs: the full gate reuses a pass while these are unchanged. */
  decl?: StageDecl
  /** Files copied to a scratch dir that replaces `{dir}` in argv (scanners never see ignored caches). */
  materialize?: string[]
  /** Acceptance fixture setup, completed before this step in the same environment. */
  setup?: string[][]
}

export interface Planned {
  id: string
  step?: Step
  skip?: string
}

const PY = ['.py', '.pyi']
const VITEST = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx', '.vue']
const BIOME = [
  '.css',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.md',
  '.mdx',
  '.scss',
  '.ts',
  '.tsx',
]
const TSC = ['.js', '.jsx', '.ts', '.tsx']
const PYTEST_CONFIG = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']
const JS_CONFIG = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']
const VITEST_CONFIG = [
  ...JS_CONFIG,
  ...['vite', 'vitest'].flatMap((n) => ['js', 'mjs', 'mts', 'ts'].map((e) => `${n}.config.${e}`)),
  'vitest.workspace.ts',
]
const LOCKS = [
  'bun.lock',
  'Cargo.lock',
  'go.mod',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'requirements.txt',
  'uv.lock',
  'yarn.lock',
]

const ext = (path: string) => posix.extname(path)
const base = (path: string) => posix.basename(path)
const isTest = (path: string) => /^test_.*\.py$|_test\.py$/.test(base(path))

/** Where a legacy tool runs: backend/ for Python tools and frontend/ for JS tools when present. */
export function toolDir(root: string, tool: string): string {
  const dir = ['ruff', 'types', 'pytest'].includes(tool) ? 'backend' : 'frontend'
  return ['ruff', 'types', 'pytest', 'vitest', 'biome', 'tsc'].includes(tool) &&
    existsSync(join(root, dir))
    ? dir
    : '.'
}

function packageData(root: string, dir: string): Record<string, unknown> {
  const file = join(root, dir, 'package.json')
  if (!existsSync(file)) return {}
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new ConfigError(`${dir}/package.json must contain a JSON object`)
  }
}

/** Applicability belongs to the implicit gate; an explicit native tool remains required. */
function legacySkip(config: Config, tool: string, listFiles: ListFiles): string | undefined {
  if (!config.legacyDefault) return undefined
  const { root } = config
  if (['ruff', 'types', 'pytest'].includes(tool)) {
    const excluded = new Set([
      '.git',
      '.venv',
      'venv',
      'node_modules',
      '.tools',
      '.dev-tools',
      'vendor',
      'build',
      'dist',
      '.next',
    ])
    if (
      !listFiles().some(
        (file) =>
          !file.split('/').some((part) => excluded.has(part)) &&
          (PY.includes(ext(file)) || base(file) === 'pyproject.toml'),
      )
    )
      return 'no_python_inputs'
  }
  if (
    tool === 'tsc' &&
    !['.', 'frontend'].some((dir) => existsSync(join(root, dir, 'tsconfig.json')))
  )
    return 'no_tsconfig'
  if (tool === 'biome' && config.toolPaths.biome === undefined) {
    const declared = ['.', 'frontend'].some((dir) => {
      if (
        ['biome.json', 'biome.jsonc', 'node_modules/.bin/biome'].some((file) =>
          existsSync(join(root, dir, file)),
        )
      )
        return true
      const data = packageData(root, dir)
      if (
        ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
          const value = data[key]
          return typeof value === 'object' && value !== null && '@biomejs/biome' in value
        })
      )
        return true
      const scripts = data.scripts
      return (
        typeof scripts === 'object' &&
        scripts !== null &&
        Object.values(scripts).some(
          (command) => typeof command === 'string' && /\bbiome\b/.test(command),
        )
      )
    })
    if (!declared) return 'no_declared_biome_configuration'
  }
  return undefined
}

/** Missing tools were optional only when the implicit gate had no prepared environment for them. */
export function missingLegacySkip(config: Config, tool: string): string | undefined {
  if (!config.legacyDefault || config.toolPaths[tool] !== undefined) return undefined
  if (tool === 'osv' || tool === 'semgrep') return 'tool_not_installed;coverage_not_claimed'
  if (!['ruff', 'types', 'pytest', 'biome', 'tsc'].includes(tool)) return undefined
  if (tool === 'biome') return undefined // legacySkip already decided whether it was declared.
  const dirs = ['tsc'].includes(tool)
    ? ['frontend/node_modules/.bin', 'node_modules/.bin']
    : ['backend/.venv/bin', '.venv/bin', 'backend/venv/bin', 'venv/bin']
  if (!dirs.some((dir) => existsSync(join(config.root, dir)))) return 'tool_not_installed'
  if (
    tool === 'tsc' &&
    !['.', 'frontend'].some((dir) => existsSync(join(config.root, dir, 'package.json')))
  )
    return 'no_package_manifest'
  return undefined
}

/** The manifest's aggregate frontend suite, including package hooks and non-Vitest scripts. */
function frontendSuite(config: Config, dir: string): { command: string[]; direct: boolean } | null {
  const data = packageData(config.root, dir)
  const scripts = (data.scripts ?? {}) as Record<string, unknown>
  const name = 'test:ci' in scripts ? 'test:ci' : 'test'
  const script = scripts[name]
  const declaresVitest = ['dependencies', 'devDependencies'].some((key) => {
    const dependencies = data[key]
    return typeof dependencies === 'object' && dependencies !== null && 'vitest' in dependencies
  })
  if (script === undefined) {
    const local = toolBinary(config, 'vitest', 'vitest', dir)
    return declaresVitest || config.toolPaths.vitest !== undefined || local !== 'vitest'
      ? { command: [], direct: true }
      : null
  }
  if (typeof script !== 'string' || !script.trim())
    throw new ConfigError(`package.json ${name} must be a nonempty command`)
  if (
    /(?:^|\s)(?:--watch(?:All)?|--ui|-w)(?:\s|=|$)/.test(script) ||
    /^vitest\s+watch(?:\s|$)/.test(script)
  )
    throw new ConfigError('Interactive test script: declare a non-watch test:ci script')
  const hooks = `pre${name}` in scripts || `post${name}` in scripts
  if (/^vitest(?:\s+run)?$/.test(script.trim()) && !hooks) return { command: [], direct: true }
  const declared = data.packageManager ?? packageData(config.root, '.').packageManager
  let manager = typeof declared === 'string' ? declared.split('@')[0] : ''
  if (declared !== undefined && !['npm', 'pnpm', 'yarn', 'bun'].includes(manager))
    throw new ConfigError('Unsupported packageManager for frontend tests')
  if (!manager) {
    manager = 'npm'
    for (const at of [dir, '.']) {
      const found = [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lock', 'bun'],
        ['bun.lockb', 'bun'],
        ['package-lock.json', 'npm'],
      ].find(([lock]) => existsSync(join(config.root, at, lock)))
      if (found) {
        manager = found[1]
        break
      }
    }
  }
  return {
    command: [
      manager,
      'run',
      name,
      ...(script.trim() === 'vitest' ? (manager === 'npm' ? ['--', '--run'] : ['--run']) : []),
    ],
    direct: false,
  }
}

/** The tool's binary: [paths] first, then the project's node_modules or venv, then PATH. */
export function toolBinary(config: Config, tool: string, binary: string, cwd: string): string {
  const { root } = config
  const declared = config.toolPaths[tool]
  if (declared !== undefined) return join(root, declared, binary)
  const js = ['vitest', 'biome', 'tsc'].includes(tool)
  const dirs = js
    ? [join(root, cwd, 'node_modules/.bin'), join(root, 'node_modules/.bin')]
    : [join(root, cwd, '.venv/bin'), join(root, '.venv/bin')]
  for (const dir of dirs) if (existsSync(join(dir, binary))) return join(dir, binary)
  return binary
}

/** Changed files under dir, relative to it, that still exist and have one of the suffixes. */
function within(root: string, dir: string, files: string[], suffixes: string[]): string[] {
  return files
    .filter((file) => dir === '.' || file.startsWith(`${dir}/`))
    .filter((file) => suffixes.includes(ext(file)) && existsSync(join(root, file)))
    .map((file) => (dir === '.' ? file : relative(dir, file)))
}

interface PythonImports {
  modules: Set<string>
  from: Set<[string, string]>
}

/** `import a.b` and `from a import b` names in a Python file (what SummitFlow's ast walk reads). */
export function pythonImports(path: string): PythonImports {
  const found: PythonImports = { modules: new Set(), from: new Set() }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return found
  }
  for (const match of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm))
    for (const name of match[1].split(','))
      if (name.trim())
        found.modules.add(
          name
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
  for (const match of text.matchAll(
    /^[ \t]*from[ \t]+\.*([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm,
  ))
    for (const name of match[2].replace(/[()\\]/g, ' ').split(','))
      if (name.trim())
        found.from.add([
          match[1],
          name
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        ])
  return found
}

/** Test files for changed Python files: changed tests, tests named after the module, tests importing it. */
export function focusedTests(root: string, dir: string, changed: string[]): string[] | null {
  const tests = new Set<string>()
  let unmapped = false
  let all: string[] | null = null
  let imports: Map<string, PythonImports> | null = null
  const listTests = (): string[] => {
    const out: string[] = []
    const walk = (rel: string) => {
      for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (
          entry.name.startsWith('.') ||
          ['node_modules', '__pycache__', '.venv'].includes(entry.name)
        )
          continue
        const path = rel === '.' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) walk(path)
        else if (isTest(path)) out.push(path)
      }
    }
    walk(dir)
    return out
  }
  for (const file of changed) {
    if (!PY.includes(ext(file)) || !existsSync(join(root, file))) continue
    if (isTest(file)) {
      tests.add(file)
      continue
    }
    all ??= listTests()
    // The dotted module, relative to the tool's directory (backend/app/x.py -> app.x).
    const parts = (dir === '.' ? file : relative(dir, file)).replace(/\.pyi?$/, '').split('/')
    if (parts.at(-1) === '__init__') parts.pop()
    if (!parts.length) continue
    const dotted = parts.join('.')
    const leaf = parts[parts.length - 1]
    const parent = parts.slice(0, -1).join('.')
    imports ??= new Map(all.map((test) => [test, pythonImports(join(root, test))]))
    const hits = all.filter((test) => {
      const name = base(test)
      if (
        name === `test_${leaf}.py` ||
        name === `${leaf}_test.py` ||
        name.startsWith(`test_${leaf}_`)
      )
        return true
      const found = imports?.get(test)
      return (
        !!found &&
        ([...found.modules].some((m) => m === dotted || m.startsWith(`${dotted}.`)) ||
          [...found.from].some(([from, n]) => from === dotted || (from === parent && n === leaf)))
      )
    })
    if (hits.length) for (const hit of hits) tests.add(hit)
    else unmapped = true
  }
  if (unmapped && !tests.size) return null
  return [...tests].sort().map((test) => (dir === '.' ? test : relative(dir, test)))
}

/**
 * Load the Vitest config through Vite's module runner and skip the results cache when the installed
 * Vitest offers both (as `st check` does): the default bundler writes node_modules/.vite-temp, which a
 * read-only checkout (an isolated acceptance) refuses.
 */
function vitestFlags(root: string, dir: string): string[] {
  for (const base of [join(root, dir), root]) {
    const chunks = join(base, 'node_modules/vitest/dist/chunks')
    let names: string[]
    try {
      names = readdirSync(chunks).filter((name) => /^cac.*\.js$/.test(name))
    } catch {
      continue
    }
    const offered = names.some((name) => {
      const text = readFileSync(join(chunks, name), 'utf8')
      return /\bconfigLoader:\s*\{[^}]*\brunner\b/.test(text) && /\bcache:\s*\{/.test(text)
    })
    if (!offered) return []
    const commonJs = [
      'vitest.config.ts',
      'vitest.config.js',
      'vitest.config.cts',
      'vite.config.ts',
      'vite.config.js',
    ].some((name) => {
      const file = join(root, dir, name)
      return existsSync(file) && /\b__(?:dirname|filename)\b/.test(readFileSync(file, 'utf8'))
    })
    return [...(commonJs ? [] : ['--configLoader', 'runner']), '--cache=false']
  }
  return []
}

function tsconfigArgs(root: string, dir: string): string[] {
  try {
    const text = readFileSync(join(root, dir, 'tsconfig.json'), 'utf8')
    if (/"references"\s*:/.test(text)) return ['-b']
  } catch {}
  return ['--noEmit', '-p', 'tsconfig.json']
}

/** Every tracked or untracked, not ignored file (what a full secret scan reads). */
export type ListFiles = () => string[]

/** Keep a declared Biome check inside the changed set, including per-package quick views. */
function scopedBiome(config: Config, decl: StageDecl, changed: string[]): string[] | null {
  const args = decl.argv.slice(2)
  const flags: string[] = []
  const paths: string[] = []
  // Biome's switches without a value; other bare options consume their next argument.
  const switches = new Set([
    '--write',
    '--fix',
    '--unsafe',
    '--verbose',
    '--staged',
    '--changed',
    '--no-errors-on-unmatched',
  ])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      paths.push(...args.slice(i + 1))
      break
    }
    if (!arg.startsWith('-')) paths.push(arg)
    else {
      flags.push(arg)
      if (!arg.includes('=') && !switches.has(arg) && args[i + 1] && !args[i + 1].startsWith('-'))
        flags.push(args[++i])
    }
  }
  const files = within(config.root, decl.cwd, changed, BIOME).filter(
    (file) => !paths.length || paths.some((path) => path === '.' || matches(file, [path])),
  )
  return files.length
    ? [
        decl.argv[0],
        'check',
        ...flags,
        '--no-errors-on-unmatched',
        '--files-ignore-unknown=true',
        '--',
        ...files,
      ]
    : null
}

function legacySteps(
  config: Config,
  tool: string,
  lane: Lane,
  changed: string[] | null,
  listFiles: ListFiles,
): Planned[] {
  const { root } = config
  const skip = legacySkip(config, tool, listFiles)
  if (skip) return [{ id: tool, skip }]
  const dir = toolDir(root, tool)
  const step = (
    id: string,
    binary: string,
    args: string[],
    extra: Partial<Step> = {},
  ): Planned => ({
    id,
    step: {
      id,
      argv: [toolBinary(config, tool, binary, dir), ...args],
      cwd: dir,
      env: 'user',
      timeoutS: 1800,
      required: true,
      ...extra,
    },
  })
  const configChanged = (names: string[]) => !!changed?.some((file) => names.includes(base(file)))
  switch (tool) {
    case 'govulncheck':
    case 'shellcheck':
    case 'actionlint': {
      const excluded = new Set([
        '.git',
        '.snapshots',
        '.venv',
        'node_modules',
        'vendor',
        'vendored',
        'generated',
        'build',
        'dist',
      ])
      const files = (changed ?? listFiles()).filter(
        (file) => !file.split('/').some((part) => excluded.has(part)),
      )
      if (tool === 'govulncheck') {
        const modules = new Set<string>()
        for (const file of files) {
          if (!file.endsWith('.go') && !['go.mod', 'go.sum'].includes(base(file))) continue
          let directory = posix.dirname(file)
          for (;;) {
            if (existsSync(join(root, directory, 'go.mod'))) {
              modules.add(directory)
              break
            }
            if (directory === '.') break
            directory = posix.dirname(directory)
          }
        }
        return modules.size
          ? [...modules].sort().map((cwd) => step(`govulncheck:${cwd}`, tool, ['./...'], { cwd }))
          : [{ id: tool, skip: 'no_relevant_paths' }]
      }
      const selected = files.filter((file) =>
        tool === 'actionlint'
          ? posix.dirname(file) === '.github/workflows' && ['.yml', '.yaml'].includes(ext(file))
          : file.endsWith('.sh') &&
            (file.startsWith('scripts/') || file.startsWith('docker/scripts/')),
      )
      return selected.length
        ? [step(tool, tool, selected.sort())]
        : [{ id: tool, skip: 'no_relevant_paths' }]
    }
    case 'ruff':
    case 'types': {
      const args =
        tool === 'ruff'
          ? ['check', '--output-format=concise']
          : ['check', '--output-format', 'concise']
      const binary = tool === 'ruff' ? 'ruff' : 'ty'
      if (!changed) return [step(tool, binary, args)]
      const files = within(root, dir, changed, PY)
      return files.length
        ? [step(tool, binary, [...args, ...files])]
        : [{ id: tool, skip: 'no_changed_paths' }]
    }
    case 'pytest': {
      const args = ['-q', '--tb=short']
      if (!changed)
        return [
          step(tool, 'pytest', [
            ...args,
            ...(config.pytestWorkers ? ['-n', String(config.pytestWorkers)] : []),
          ]),
        ]
      const files = within(root, dir, changed, PY)
      if (configChanged(PYTEST_CONFIG) || files.some((file) => base(file) === 'conftest.py'))
        return [{ id: tool, skip: 'whole_suite_runs_in_the_full_gate:config_or_conftest_changed' }]
      if (!files.length) return [{ id: tool, skip: 'no_relevant_changed_paths' }]
      const tests = focusedTests(
        root,
        dir,
        changed.filter((file) => dir === '.' || file.startsWith(`${dir}/`)),
      )
      if (tests === null) return [{ id: tool, skip: 'no_tests_name_the_changed_modules' }]
      return tests.length
        ? [step(tool, 'pytest', [...args, ...(config.pytestNoCov ? ['--no-cov'] : []), ...tests])]
        : [{ id: tool, skip: 'no_relevant_changed_paths' }]
    }
    case 'vitest': {
      if (config.legacyDefault) {
        const suite = frontendSuite(config, dir)
        if (!suite) return [{ id: tool, skip: 'no_declared_frontend_suite' }]
        if (!suite.direct)
          return changed
            ? [{ id: 'frontend-test', skip: 'whole_suite_runs_in_the_full_gate:package_script' }]
            : [step('frontend-test', suite.command[0], suite.command.slice(1))]
      }
      const flags = vitestFlags(root, dir)
      if (!changed) return [step(tool, 'vitest', ['run', ...flags])]
      const files = within(root, dir, changed, VITEST)
      if (files.length) return [step(tool, 'vitest', ['related', '--run', ...flags, ...files])]
      return [
        {
          id: tool,
          skip: configChanged(VITEST_CONFIG)
            ? 'whole_suite_runs_in_the_full_gate:config_changed'
            : 'no_relevant_changed_paths',
        },
      ]
    }
    case 'biome': {
      if (!changed) return [step(tool, 'biome', ['check', '.'])]
      const files = within(root, dir, changed, BIOME)
      return files.length
        ? [step(tool, 'biome', ['check', ...files])]
        : [{ id: tool, skip: 'no_relevant_changed_paths' }]
    }
    case 'tsc': {
      if (
        changed &&
        !within(root, dir, changed, TSC).length &&
        !configChanged(['tsconfig.json', ...JS_CONFIG])
      )
        return [{ id: tool, skip: 'no_relevant_changed_paths' }]
      return [step(tool, 'tsc', tsconfigArgs(root, dir))]
    }
    case 'security':
      return lane === 'quick'
        ? legacySteps(config, 'gitleaks', lane, changed, listFiles)
        : ['gitleaks', 'osv', 'semgrep'].flatMap((name) =>
            legacySteps(config, name, lane, changed, listFiles),
          )
    case 'gitleaks': {
      const files = (changed ?? listFiles()).filter((file) => existsSync(join(root, file)))
      if (!files.length) return [{ id: tool, skip: 'no_candidate_files' }]
      const own = existsSync(join(root, '.gitleaks.toml'))
        ? ['--config', join(root, '.gitleaks.toml')]
        : []
      return [
        step(
          tool,
          'gitleaks',
          [
            'dir',
            '--no-banner',
            '--redact',
            ...own,
            '--report-format',
            'json',
            '--report-path',
            '-',
            '{dir}',
          ],
          {
            materialize: files,
            cwd: '.',
          },
        ),
      ]
    }
    case 'osv': {
      const locks = (changed ?? listFiles()).filter(
        (file) => LOCKS.includes(base(file)) && existsSync(join(root, file)),
      )
      if (!locks.length) return [{ id: tool, skip: 'no_candidate_lockfiles' }]
      return [
        step(
          tool,
          'osv-scanner',
          [
            'scan',
            'source',
            '--format',
            'json',
            '--verbosity',
            'error',
            ...locks.flatMap((lock) => ['--lockfile', lock]),
          ],
          {
            cwd: '.',
          },
        ),
      ]
    }
    case 'semgrep': {
      const rules = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find((name) =>
        existsSync(join(root, name)),
      )
      if (!rules) return [{ id: tool, skip: 'no_local_rules' }]
      const files = (changed ?? listFiles()).filter((file) => existsSync(join(root, file)))
      return [
        step(
          tool,
          'semgrep',
          [
            'scan',
            '--config',
            join(root, rules),
            '--metrics',
            'off',
            '--disable-version-check',
            '--error',
            '--json',
            '{dir}',
          ],
          {
            materialize: files,
            cwd: '.',
          },
        ),
      ]
    }
  }
  return [{ id: tool, skip: 'unsupported' }]
}

/**
 * The legacy tools a lane runs. The quick lane, like `st check --quick`, also runs pytest and Vitest
 * on the changed files when the project has them installed, even where the full gate leaves its
 * suites to native stages (`legacy_tools` without them).
 */
function legacyTools(config: Config, lane: Lane): string[] {
  if (lane !== 'quick') return config.legacy
  const installed = (tool: string, binary: string) => {
    const dir = toolDir(config.root, tool)
    const path = toolBinary(config, tool, binary, dir)
    return path !== binary && existsSync(path)
  }
  const extra = [
    ...(!config.stages.some((stage) =>
      stage.argv.some((arg) =>
        arg.split(/\s+/).some((token) => posix.basename(token) === 'pytest'),
      ),
    ) && installed('pytest', 'pytest')
      ? ['pytest']
      : []),
    ...(!config.stages.some((stage) =>
      stage.argv.some((arg) =>
        arg.split(/\s+/).some((token) => posix.basename(token) === 'vitest'),
      ),
    ) && installed('vitest', 'vitest')
      ? ['vitest']
      : []),
  ]
  return [...new Set([...config.legacy, ...extra])]
}

/**
 * The steps of one run. `changed` is the changed-file scope (null for the whole tree). The quick lane
 * runs stages that opted in (`quick = true`, narrowed by `quick_paths`) and the legacy tools on the
 * changed files; the full gate runs every applicable stage except views of another (`covered_by`).
 */
export function plan(
  config: Config,
  lane: Lane,
  changed: string[] | null,
  listFiles: ListFiles,
): Planned[] {
  const out: Planned[] = []
  for (const tool of legacyTools(config, lane))
    out.push(...legacySteps(config, tool, lane, changed, listFiles))
  for (const decl of config.stages) {
    const scoped =
      changed && posix.basename(decl.argv[0]) === 'biome' && decl.argv[1] === 'check'
        ? scopedBiome(config, decl, changed)
        : decl.argv
    const native = (skip?: string): Planned =>
      skip || !scoped
        ? { id: decl.id, skip: skip ?? 'no_relevant_changed_paths' }
        : {
            id: decl.id,
            step: {
              id: decl.id,
              argv: scoped,
              cwd: decl.cwd,
              env: 'stage',
              timeoutS: decl.timeoutS,
              required: decl.required,
              decl,
            },
          }
    if (!decl.applicable) out.push(native(decl.reason))
    else if (lane === 'quick') {
      if (!decl.quick) continue
      out.push(
        native(
          changed &&
            decl.quickPaths.length &&
            !changed.some((file) => matches(file, decl.quickPaths))
            ? 'no_relevant_changed_paths'
            : undefined,
        ),
      )
    } else if (!decl.coveredBy) out.push(native())
  }
  return out
}
