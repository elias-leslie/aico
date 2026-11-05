import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, hostname, loadavg, uptime } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readQuery } from '@aico/store'
import { registryProjects } from '@aico/tasks'
import { withOwnWidget } from '@aico/tether-client/own-session'
import config from '../data/cli.json' with { type: 'json' }
import usage from '../data/usage.json' with { type: 'json' }
import { catalog, executable, extensionEnvironment, passiveHelp } from './extensions'

export type Run = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
export const run: Run = (argv, env) =>
  new Promise((done, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: 'inherit', detached: true })
    const forward = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal)
        } catch {
          /* Already exited. */
        }
    }
    const interrupt = () => forward('SIGINT')
    const terminate = () => forward('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const clean = () => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    child.on('error', (error) => {
      clean()
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clean()
      done(code ?? (signal === 'SIGINT' ? 130 : 143))
    })
  })
const ALIASES: Record<string, string[]> = {
  create: ['tasks', 'create'],
  list: ['tasks', 'list'],
  context: ['tasks', 'context'],
  claim: ['tasks', 'claim'],
  log: ['tasks', 'log'],
  done: ['tasks', 'done'],
  abandon: ['tasks', 'abandon'],
  task: ['tasks'],
  backup: ['backups'],
  snap: ['snapshots', 'take'],
  snaps: ['snapshots', 'list'],
  rollback: ['snapshots', 'restore'],
}
const NATIVE = new Set([
  'tasks',
  'projects',
  'pulse',
  'lease',
  'memory',
  'prompt',
  'models',
  'usage',
  'app',
  'phones',
  'logins',
  'check',
  'commit',
  'publish',
  'deploy',
  'logs',
  'snapshots',
  'vm',
  'backups',
  'web',
  'ask',
  'grants',
  'elevate',
])
const CORE = new Set([
  ...NATIVE,
  ...Object.keys(ALIASES),
  'aico',
  'sessions',
  'tools',
  'db',
  'mockup',
  'monitor',
  'status',
  'tether',
  'mandates',
  'vcs',
  'service',
])
export interface Options {
  root?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  execute?: Run
  out?: (line: string) => void
  err?: (line: string) => void
  fetcher?: typeof fetch
  ownEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))

export function apiBase(root: string, env: NodeJS.ProcessEnv): string {
  if (env.AICO_API_BASE) return env.AICO_API_BASE.replace(/\/$/, '')
  if (env.AICO_WEB_URL) return `${env.AICO_WEB_URL.replace(/\/$/, '')}/api`
  const identity = JSON.parse(readFileSync(join(root, 'project.identity.json'), 'utf8'))
  return `http://127.0.0.1:${env.AICO_WEB_PORT || identity.runtime.backend_port}/api`
}
export async function main(argv: string[], options: Options = {}): Promise<number> {
  const root =
    options.root ??
    process.env.AICO_REPO_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const env = options.env ?? process.env,
    cwd = options.cwd ?? process.cwd(),
    execute = options.execute ?? run
  const out = options.out ?? console.log,
    err = options.err ?? console.error
  const legacy = join(root, 'packages/web-server/scripts/aico')
  let selectedEnv = env
  const delegate = (args: string[]) =>
    execute(
      [legacy, ...args],
      args[0] === 'deploy'
        ? {
            ...selectedEnv,
            AICO_DEPLOY_ROOT:
              selectedEnv.AICO_DEPLOY_ROOT ||
              registryProjects(selectedEnv).find((project) => project.id === 'aico')?.root ||
              cwd,
          }
        : selectedEnv,
    )
  const state =
    env.SUMMITFLOW_SERVICE_STATE_ROOT || join(env.HOME || homedir(), '.summitflow/services')
  const data = join(root, 'packages/cli/data')
  const help = () =>
    out(
      'Usage: st <tasks|projects|sessions|pulse|lease|check|commit|service|logs|backup|vm|memory|prompt|models|web|logins|tools|db|mockup|monitor> ...\nStandalone tools: browser, ui, neri, jobs, portfolio, bugout, ominull, uilint, wiki.\nUse st tools manifest --discover WORD for command details.',
    )
  try {
    const args = [...argv]
    let projectId = env.AICO_PROJECT_ID || env.ST_PROJECT_ID || null
    const output = { human: false, compact: true, progress_only: false }
    while (args[0]?.startsWith('-') && !['--help', '-h'].includes(args[0])) {
      const option = args.shift()
      if (option === '-P' || option === '--project') {
        projectId = args.shift() || null
        if (!projectId) throw new Error('Project option needs an id')
      } else if (option === '--human') output.human = true
      else if (option === '--compact' || option === '-c') output.compact = true
      else if (option === '--no-compact') output.compact = false
      else if (option === '--progress-only') output.progress_only = true
      else throw new Error(`Unknown root option ${option}`)
    }
    output.human = output.human && !output.compact && !output.progress_only
    output.compact = output.compact || output.progress_only
    if (projectId) selectedEnv = { ...env, AICO_PROJECT_ID: projectId, ST_PROJECT_ID: projectId }
    const [verb, ...rest] = args
    if (!verb || ['help', '--help', '-h'].includes(verb)) {
      help()
      return verb ? 0 : 2
    }
    if (verb in config.removed) {
      err(
        `st ${verb}: ${config.removed[verb as keyof typeof config.removed]} in the Aico consolidation.`,
      )
      return 2
    }
    if (verb === 'tools') {
      if (rest[0] === 'run')
        return execute(['python3', join(root, 'native/st-sdk/tools_run.py'), ...rest.slice(1)], env)
      const extensions = catalog(data, state, CORE)
      if (rest[0] === 'extensions') {
        const check = rest.includes('--check')
        out(
          json({
            contract_version: 1,
            extensions: extensions.map((e) => {
              let status = e.status,
                diagnostic = 'Runtime not checked'
              if (check) {
                try {
                  executable(
                    e,
                    registryProjects(env).find((p) => p.id === e.binding.owner)?.root,
                    state,
                  )
                  status = 'prerequisites-present'
                  diagnostic = 'Executable exists'
                } catch (error) {
                  status = 'missing-dependency'
                  diagnostic = (error as Error).message
                }
              }
              return {
                id: e.binding.id,
                owner: e.binding.owner,
                namespace: e.binding.namespace,
                version: e.manifest.version,
                status,
                diagnostic,
              }
            }),
          }),
        )
        return 0
      }
      if (rest[0] !== 'manifest') {
        out(
          'Usage: st tools manifest [--surface ID|--discover WORD] [--density core|full] [--format json|inject]\n       st tools extensions [--check]\n       st tools run --label TEXT -- COMMAND ...',
        )
        return rest.includes('--help') ? 0 : 2
      }
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          surface: { type: 'string' },
          discover: { type: 'string' },
          density: { type: 'string' },
          format: { type: 'string' },
          task: { type: 'string' },
          agent: { type: 'string' },
          profile: { type: 'string' },
          help: { type: 'boolean' },
        },
      })
      if (values.help) {
        out(
          'st tools manifest --surface ID | --discover WORD | --density core|full [--format json|inject]',
        )
        return 0
      }
      const rows = [
        ...new Map(
          [
            ...usage,
            ...extensions.flatMap((e) => (e.status === 'unverified' ? e.manifest.usage : [])),
          ].map((row) => [row.surface, row]),
        ).values(),
      ] as Record<string, unknown>[]
      const found = rows.filter((row) =>
        values.surface
          ? row.surface === values.surface
          : values.discover
            ? JSON.stringify(row).toLowerCase().includes(values.discover.toLowerCase())
            : values.task
              ? (row.task_types as string[] | undefined)?.includes(values.task)
              : values.density === 'full' || row.tier === 'mandate' || row.tier === 'guardrail',
      )
      if (!found.length && (values.surface || values.discover))
        throw new Error(`No tool surface matches ${values.surface || values.discover}`)
      if (values.format === 'json') out(json({ manifest_version: 1, tools: found }))
      else
        for (const row of found) {
          out(`${row.surface}: ${row.cmd}${row.when ? ` — ${row.when}` : ''}`)
          for (const note of (row.precautions as string[]) ?? []) out(`  ${note}`)
        }
      return 0
    }
    if (verb === 'db') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          store: { type: 'string' },
          target: { type: 'string', short: 't' },
          limit: { type: 'string' },
          help: { type: 'boolean' },
        },
      })
      if (values.help || !positionals.length) {
        out(
          `Usage: st db tables|schema TABLE|count TABLE|sample TABLE [N]|query SQL [--store NAME]\nRead-only Aico stores: ${Object.keys(config.stores).join(', ')}. -t is the query text alias.`,
        )
        return 0
      }
      const store = values.store || 'tasks'
      const filename = config.stores[store as keyof typeof config.stores]
      if (!filename) throw new Error(`Unknown store ${store}`)
      const dir =
        env.AICO_DATA_DIR ||
        join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'aico')
      const table = positionals[1]
      const identifier = () => {
        if (!table || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))
          throw new Error('A table name is required')
        return `"${table}"`
      }
      const limit = Number(positionals[2] || values.limit || 5)
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('Sample limit is 1 to 1000')
      let sql: string
      switch (positionals[0]) {
        case 'tables':
          sql = "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
          break
        case 'schema':
          sql = `SELECT sql FROM sqlite_schema WHERE name='${identifier().slice(1, -1)}'`
          break
        case 'count':
          sql = `SELECT count(*) AS count FROM ${identifier()}`
          break
        case 'sample':
          sql = `SELECT * FROM ${identifier()} LIMIT ${limit}`
          break
        case 'query':
          sql = values.target || positionals.slice(1).join(' ')
          break
        default:
          throw new Error('st db is read-only: tables, schema, count, sample, query')
      }
      out(json(readQuery(join(dir, filename), sql)))
      return 0
    }
    if (verb === 'mockup') {
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        allowPositionals: true,
        options: {
          project: { type: 'string' },
          title: { type: 'string' },
          note: { type: 'string' },
          session: { type: 'string' },
          help: { type: 'boolean' },
        },
      })
      if (rest[0] !== 'add' || values.help) {
        out('Usage: st mockup add FILE --project ID --title TITLE [--note TEXT] [--session ID]')
        return values.help ? 0 : 2
      }
      if (!positionals[0] || !values.project || !values.title)
        throw new Error('mockup add needs FILE --project ID --title TITLE')
      const candidate = (
        values.session ||
        (options.ownEnv ?? withOwnWidget)(env).AICO_WIDGET_ID ||
        env.AICO_SESSION_ID ||
        ''
      ).replace(/^aico-widget-/, '')
      const response = await (options.fetcher ?? fetch)(`${apiBase(root, env)}/mockups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json({
          project: values.project,
          title: values.title,
          note: values.note || '',
          html: readFileSync(resolve(cwd, positionals[0]), 'utf8'),
          session: /^[0-9a-f]{8}$/.test(candidate) ? candidate : null,
        }),
      })
      const body = (await response.json()) as { detail?: string; pageUrl?: string }
      if (!response.ok)
        throw new Error(body.detail || `Mockup was not saved: HTTP ${response.status}`)
      out(json(body))
      return 0
    }
    if (verb === 'monitor') {
      if (!rest[0] || rest.includes('--help')) {
        out(
          'Usage: st monitor status|system-info|connections|processes|mounts\nLocal /proc readings; service logs: st logs UNIT.',
        )
        return 0
      }
      if (rest[0] === 'status' || rest[0] === 'system-info')
        out(
          json({
            load: loadavg(),
            uptime: uptime(),
            memory: readFileSync('/proc/meminfo', 'utf8'),
            pressure: readFileSync('/proc/pressure/memory', 'utf8'),
          }),
        )
      else if (rest[0] === 'connections')
        out(readFileSync('/proc/net/tcp', 'utf8') + readFileSync('/proc/net/tcp6', 'utf8'))
      else if (rest[0] === 'mounts') out(readFileSync('/proc/mounts', 'utf8'))
      else if (rest[0] === 'processes')
        return execute(['ps', '-eo', 'pid,ppid,comm,rss', '--sort=-rss'], env)
      else
        throw new Error(
          `st monitor ${rest[0]}: dropped; use status, connections, processes, mounts or st logs UNIT`,
        )
      return 0
    }
    if (verb === 'aico') return execute(['python3', join(root, config.rootHelper), ...rest], env)
    if (verb === 'sessions') {
      if (['send', 'ack', 'confirm', 'inbox', 'may-disrupt'].includes(rest[0]))
        return execute(['aico-hook', 'sessions', ...rest], env)
      if (rest[0] === 'wait')
        return execute(['python3', join(root, config.rootHelper), 'wait', ...rest.slice(1)], env)
      return execute(['tether', 'history', ...rest], env)
    }
    if (verb === 'tether')
      return execute([join(root, 'packages/tether/scripts/st-tether'), ...rest], env)
    if (verb === 'status')
      return execute([join(root, 'packages/web-server/scripts/st-status'), ...rest], env)
    if (verb === 'mandates')
      return delegate([
        'context',
        'deliver',
        '--tool',
        env.CODEX_THREAD_ID ? 'codex' : env.CLAUDE_CODE_SESSION_ID ? 'claude-code' : 'pi',
        ...rest,
      ])
    if (verb === 'vcs') {
      if (rest[0] === 'publish') return delegate(['publish', ...rest.slice(1)])
      throw new Error('st vcs: use st publish for publication or git for local inspection')
    }
    if (verb === 'git') return execute(['git', ...rest], env)
    if (verb === 'service') {
      const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
      const serviceEnv = {
        ...selectedEnv,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
      }
      const code = await execute(
        [join(root, 'native/service-tools/st-service'), ...rest],
        serviceEnv,
      )
      if (code === 3 && rest[0] === 'rebuild') return delegate(['deploy', ...rest.slice(1)])
      if (code === 3 && ['result', 'wait'].includes(rest[0])) return delegate(['deploy', ...rest])
      return code
    }
    if (env.AICO_CLI_NAME === 'aico' && ['context', 'jobs', 'agent'].includes(verb))
      return delegate([verb, ...rest])
    if (verb === 'projects')
      return delegate(
        ['projects', ...(rest.length ? rest : ['list'])].filter((x) => x !== '--json'),
      )
    if (ALIASES[verb])
      return delegate([
        ...ALIASES[verb],
        ...rest,
        ...(projectId && ['snap', 'snaps', 'rollback'].includes(verb)
          ? ['--project', projectId]
          : projectId && ALIASES[verb][0] === 'tasks'
            ? ['-P', projectId]
            : []),
      ])
    if (verb === 'prompt' && !output.compact && !output.human)
      return delegate(['prompt', ...rest, '--json'])
    if (NATIVE.has(verb))
      return delegate([verb, ...rest, ...(verb === 'tasks' && projectId ? ['-P', projectId] : [])])
    const extension = catalog(data, state, CORE).find((e) => e.binding.namespace === verb)
    if (extension) {
      const help = extension.status === 'collision' ? null : passiveHelp(extension, rest)
      if (help !== null) {
        out(help)
        return 0
      }
      if (extension.status !== 'unverified')
        throw new Error(`Extension ${verb}: ${extension.status}`)
      const projects = registryProjects(env)
      const project = projectId
        ? projects.find((p) => p.id === projectId)
        : projects
            .filter((p) => cwd === p.root || cwd.startsWith(`${p.root}/`))
            .sort((a, b) => b.root.length - a.root.length)[0]
      const context = {
        contract_version: 1,
        project_id: project?.id ?? projectId,
        project_root: project?.root ?? null,
        cwd,
        api_base: apiBase(root, env),
        agent_hub_url: env.AGENT_HUB_URL || config.agentHubUrl,
        output,
      }
      const childEnv = extensionEnvironment(extension.binding, env, context)
      const session =
        env.CODEX_THREAD_ID ||
        env.CODEX_SESSION_ID ||
        env.CLAUDE_CODE_SESSION_ID ||
        env.CLAUDE_SESSION_ID ||
        env.PI_SESSION_ID
      const provider =
        env.CODEX_THREAD_ID || env.CODEX_SESSION_ID
          ? 'codex_cli'
          : env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID
            ? 'claude_code'
            : env.PI_SESSION_ID
              ? 'pi'
              : 'hostname'
      const slug =
        provider === 'codex_cli' ? 'codex' : provider === 'claude_code' ? 'claude-code' : 'pi'
      childEnv.ST_CALLER_IDENTITY = JSON.stringify(
        session
          ? { member_id: `${provider}:${slug}:${session}`, provider, session_id: session }
          : { member_id: hostname(), provider },
      )
      return execute(
        [
          executable(
            extension,
            projects.find((p) => p.id === extension.binding.owner)?.root,
            state,
          ),
          ...(extension.binding.arguments ?? []),
          ...rest,
        ],
        childEnv,
      )
    }
    throw new Error(`Unknown command ${verb}; use st --help`)
  } catch (error) {
    err(`st: ${(error as Error).message}`)
    return 2
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error((error as Error).message)
      process.exitCode = 1
    },
  )
