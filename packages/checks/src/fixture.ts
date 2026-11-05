// Local acceptance fixtures: the committed TOML owns the test environment, setup
// commands and disposable service database. The owner's shell and .env are not inputs.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { type Config, ConfigError, type Planned, toolBinary } from './plan'
import type { TomlTable } from './toml'

interface Service {
  image: string
  env: Record<string, string>
}
interface Fixture {
  env: Record<string, string>
  passEnv: string[]
  tools: string[]
  pytest?: { cwd: string; argv: string[]; setup: string[][]; services: Record<string, Service> }
}
interface CommandResult {
  code: number | null
  output: string
}
export interface FixtureRuntime {
  which(name: string): string | undefined
  run(argv: string[], env: NodeJS.ProcessEnv): Promise<CommandResult>
  freePort(): Promise<number>
  now(): number
  pause(): Promise<void>
  dockerAvailable?(): boolean
}

const list = (raw: unknown, name: string): string[] => {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string'))
    throw new ConfigError(`${name} must be an array of strings`)
  return raw as string[]
}
const table = (raw: unknown, name: string): TomlTable => {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ConfigError(`${name} must be a table`)
  return raw as TomlTable
}
const environment = (raw: unknown, name: string): Record<string, string> => {
  const value = table(raw, name)
  if (Object.values(value).some((item) => typeof item !== 'string'))
    throw new ConfigError(`${name} values must be strings`)
  return value as Record<string, string>
}
function fixture(config: Config): Fixture {
  const raw = table(config.acceptance, 'acceptance')
  const result: Fixture = {
    env: environment(raw.env, 'acceptance.env'),
    passEnv: list(raw.pass_env, 'acceptance.pass_env'),
    tools: list(raw.host_tools, 'acceptance.host_tools'),
  }
  if (raw.pytest === undefined) return result
  const py = table(raw.pytest, 'acceptance.pytest')
  const cwd = py.working_directory ?? '.'
  if (
    typeof cwd !== 'string' ||
    isAbsolute(cwd) ||
    relative(config.root, resolve(config.root, cwd)).startsWith('..') ||
    !existsSync(resolve(config.root, cwd))
  )
    throw new ConfigError('acceptance.pytest.working_directory must be a project directory')
  const setup = py.setup ?? []
  if (!Array.isArray(setup))
    throw new ConfigError('acceptance.pytest.setup must be an array of command arrays')
  const commands = setup.map((command, index) => {
    const args = list(command, `acceptance.pytest.setup[${index}]`)
    if (!args.length) throw new ConfigError('acceptance.pytest.setup commands must not be empty')
    return args
  })
  const services: Record<string, Service> = {}
  for (const [name, value] of Object.entries(table(py.services, 'acceptance.pytest.services'))) {
    const spec = table(value, `acceptance.pytest.services.${name}`)
    if (typeof spec.image !== 'string' || !spec.image)
      throw new ConfigError(`acceptance service ${name} needs an image`)
    services[name] = {
      image: spec.image,
      env: environment(spec.env, `acceptance.pytest.services.${name}.env`),
    }
  }
  result.tools.push(...list(py.tools, 'acceptance.pytest.tools'))
  result.pytest = { cwd, argv: list(py.argv, 'acceptance.pytest.argv'), setup: commands, services }
  return result
}

const canonicalPath = () => [join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin']
const runtime: FixtureRuntime = {
  which: (name) =>
    canonicalPath()
      .map((dir) => join(dir, name))
      .find((path) => existsSync(path)),
  run: (argv, env) =>
    new Promise((resolveResult) => {
      const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.on('error', () => resolveResult({ code: null, output: '' }))
      child.on('close', (code) => resolveResult({ code, output }))
    }),
  freePort: () =>
    new Promise((resolvePort, reject) => {
      const socket = createServer()
      socket.on('error', reject)
      socket.listen(0, '127.0.0.1', () => {
        const address = socket.address()
        socket.close(() =>
          typeof address === 'object' && address
            ? resolvePort(address.port)
            : reject(new ConfigError('Cannot allocate test service port')),
        )
      })
    }),
  now: () => Date.now(),
  pause: () => new Promise((resolvePause) => setTimeout(resolvePause, 500)),
  dockerAvailable: () => {
    if (process.env.DOCKER_HOST) return true
    try {
      accessSync('/var/run/docker.sock', constants.R_OK | constants.W_OK)
      return true
    } catch {
      return false
    }
  },
}

/** Resolve prepared local Python commands without letting uv install or sync dependencies. */
function prepared(config: Config, cwd: string, input: string[]): string[] {
  if (!input.length) return input
  let argv = input
  if (argv[0] === 'uv' && argv[1] === 'run') {
    const flags = new Set([
      '--locked',
      '--frozen',
      '--no-sync',
      '--all-extras',
      '--dev',
      '--offline',
      '--no-dev',
      '-q',
      '--quiet',
    ])
    const values = new Set([
      '--extra',
      '--group',
      '--with',
      '--python',
      '-p',
      '--package',
      '--project',
      '--directory',
    ])
    let at = 2
    while (argv[at]?.startsWith('-')) {
      if (values.has(argv[at])) at += 2
      else if (flags.has(argv[at]) || argv[at].includes('=')) at++
      else throw new ConfigError(`Unsupported acceptance uv run option ${argv[at]}`)
    }
    argv = argv.slice(at)
    if (!argv.length) throw new ConfigError('acceptance uv run needs a command')
    const executable = join(config.root, cwd, '.venv/bin', argv[0])
    if (!existsSync(executable))
      throw new ConfigError('Acceptance uv run requires its prepared local executable')
    return [executable, ...argv.slice(1)]
  }
  if (argv[0].includes('/'))
    return [isAbsolute(argv[0]) ? argv[0] : join(config.root, cwd, argv[0]), ...argv.slice(1)]
  const local = join(config.root, cwd, '.venv/bin', argv[0])
  if (existsSync(local)) return [local, ...argv.slice(1)]
  if (argv[0] === 'pytest') return [toolBinary(config, 'pytest', 'pytest', cwd), ...argv.slice(1)]
  return argv
}

function seeded(argv: string[], seed: string | undefined): string[] {
  if (!seed || argv.some((arg) => arg.includes('no:randomly') || arg.startsWith('--randomly-seed')))
    return argv
  const lib = join(dirname(dirname(argv[0])), 'lib')
  try {
    if (
      readdirSync(lib).some(
        (version) =>
          version.startsWith('python') &&
          existsSync(join(lib, version, 'site-packages')) &&
          readdirSync(join(lib, version, 'site-packages')).some((name) =>
            name.startsWith('pytest_randomly'),
          ),
      )
    )
      return [...argv, `--randomly-seed=${seed}`]
  } catch {}
  return argv
}

/** Own every service until completion or failure, and always remove the containers we started. */
export async function withAcceptanceFixture<T>(
  config: Config,
  planned: Planned[],
  scratch: string,
  base: NodeJS.ProcessEnv,
  operation: (steps: Planned[], env: NodeJS.ProcessEnv) => Promise<T>,
  host: FixtureRuntime = runtime,
): Promise<T> {
  const declared = fixture(config)
  const aliases = join(scratch, 'bin')
  const home = join(scratch, 'home')
  mkdirSync(aliases, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const name of new Set(['git', ...declared.tools])) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new ConfigError('acceptance tools must be executable names')
    const found = host.which(name)
    if (found) symlinkSync(found, join(aliases, name))
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    PATH: [aliases, '/usr/bin', '/bin'].join(':'),
    ...declared.env,
  }
  for (const key of declared.passEnv) if (base[key] !== undefined) env[key] = base[key]
  env.ST_CHECK_SEED = base.ST_CHECK_SEED ?? String(randomBytes(4).readUInt32BE())
  env.ST_CHECK_CI_PARITY = '1'
  const py = declared.pytest
  const selected = planned.map((item) => {
    if (!item.step) return item
    if (item.id !== 'pytest') {
      const argv = item.step.argv
      const found =
        item.step.env === 'user' && !argv[0].includes('/') ? host.which(argv[0]) : undefined
      return found ? { ...item, step: { ...item.step, argv: [found, ...argv.slice(1)] } } : item
    }
    const cwd = py?.cwd ?? item.step.cwd
    return {
      ...item,
      step: {
        ...item.step,
        cwd,
        argv: seeded(
          py?.argv.length ? prepared(config, cwd, py.argv) : item.step.argv,
          env.ST_CHECK_SEED,
        ),
        setup: py?.setup.map((argv) => prepared(config, cwd, argv)),
      },
    }
  })
  const started: { engine: string[]; container: string }[] = []
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  let cleanupFailed = false
  try {
    // A fixture is only needed when this gate actually selected pytest.
    for (const [name, spec] of Object.entries(
      selected.some((item) => item.id === 'pytest' && item.step) ? (py?.services ?? {}) : {},
    )) {
      if (!`${name} ${spec.image}`.includes('postgres'))
        throw new ConfigError(`Acceptance service ${name} has no local equivalent`)
      const docker = host.which('docker')
      const podman = host.which('podman')
      const runtimeDir =
        base.XDG_RUNTIME_DIR ??
        (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '')
      const podmanSocket = join(runtimeDir, 'podman/podman.sock')
      const sudo = host.which('sudo')
      const engine =
        docker && (host.dockerAvailable?.() ?? true)
          ? [docker]
          : podman && existsSync(podmanSocket)
            ? [podman, '--remote', '--url', `unix://${podmanSocket}`]
            : docker && sudo
              ? [sudo, '-n', docker]
              : undefined
      if (!engine)
        throw new ConfigError(
          'docker or a prepared podman service is required for the acceptance database',
        )
      const port = await host.freePort()
      const container = `aico-check-${name.replace(/[^A-Za-z0-9_.-]/g, '-')}-${randomBytes(4).toString('hex')}`
      const image =
        engine[0] === podman && !/^[^/]+[.:][^/]*\//.test(spec.image)
          ? `docker.io/${spec.image.includes('/') ? '' : 'library/'}${spec.image}`
          : spec.image
      const serviceEnv = Object.entries(spec.env).flatMap(([key, value]) => [
        '-e',
        `${key}=${value}`,
      ])
      // Register before launch: even a failed/partial launch must be cleaned up.
      started.push({ engine, container })
      const launched = await host.run(
        [
          ...engine,
          'run',
          '-d',
          '--rm',
          '--name',
          container,
          '-p',
          `127.0.0.1:${port}:5432`,
          '--tmpfs',
          '/var/lib/postgresql/data',
          ...serviceEnv,
          image,
        ],
        base,
      )
      if (launched.code !== 0) throw new ConfigError(`Acceptance service ${name} did not start`)
      const user = spec.env.POSTGRES_USER ?? 'postgres'
      const database = spec.env.POSTGRES_DB ?? user
      const deadline = host.now() + 60_000 // Same readiness bound as the existing local CI fixture.
      while (
        (
          await host.run(
            [
              ...engine,
              'exec',
              container,
              'psql',
              '-h',
              '127.0.0.1',
              '-U',
              user,
              '-d',
              database,
              '-tAc',
              'select 1',
            ],
            base,
          )
        ).code !== 0
      ) {
        if (host.now() > deadline)
          throw new ConfigError(`Acceptance service ${name} did not become ready`)
        await host.pause()
      }
      env.PGHOST = '127.0.0.1'
      env.PGPORT = String(port)
      for (const [key, value] of Object.entries(env))
        if (value !== undefined)
          env[key] = value.replace(/(?<=@)(localhost|127\.0\.0\.1):5432\b/g, `127.0.0.1:${port}`)
    }
    outcome = { ok: true, value: await operation(selected, env) }
  } catch (error) {
    outcome = { ok: false, error }
  } finally {
    for (const { engine, container } of started.reverse()) {
      try {
        const removed = await host.run([...engine, 'rm', '-f', container], base)
        if (removed.code !== 0) cleanupFailed = true
      } catch {
        cleanupFailed = true
      }
    }
  }
  if (!outcome.ok) throw outcome.error
  if (cleanupFailed) throw new ConfigError('Acceptance service cleanup failed')
  return outcome.value
}
