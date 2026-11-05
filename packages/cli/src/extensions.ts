import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

export interface Binding {
  id: string
  owner: string
  namespace: string
  manifest: string
  owner_manifest?: string
  executable: string
  execution_source?: string
  grant: { enabled: boolean; effects: string[] }
  arguments?: string[]
  environment?: string[]
  owner_help?: boolean
}
export interface Manifest {
  id: string
  owner: string
  namespace: string
  version: string
  st_contract_versions: number[]
  effects: string[]
  summary: string
  help: Record<string, string>
  help_options?: Record<string, Record<string, number>>
  usage: Record<string, unknown>[]
}
export interface Extension {
  binding: Binding
  manifest: Manifest
  status: string
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string')
export function inside(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..'))
    throw new Error('Expected a project-relative path')
  const target = realpathSync(join(root, path))
  if (relative(realpathSync(root), target).startsWith('..'))
    throw new Error('Extension path escapes its registered root')
  return target
}
export function parseBinding(value: unknown): Binding {
  if (
    !object(value) ||
    !['id', 'owner', 'namespace', 'manifest', 'executable'].every(
      (k) => typeof value[k] === 'string' && value[k],
    )
  )
    throw new Error('Invalid extension binding')
  if (
    !/^[a-z][a-z0-9-]*$/.test(String(value.namespace)) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(String(value.owner))
  )
    throw new Error('Invalid extension namespace or owner')
  if (
    !object(value.grant) ||
    typeof value.grant.enabled !== 'boolean' ||
    !strings(value.grant.effects)
  )
    throw new Error('Invalid extension grant')
  if (
    value.environment !== undefined &&
    (!strings(value.environment) ||
      value.environment.some(
        (k) =>
          !/^[A-Z][A-Z0-9_]*$/.test(k) ||
          [
            'PYTHONPATH',
            'PYTHONHOME',
            'ST_EXTENSION_CONTEXT',
            'LD_PRELOAD',
            'LD_LIBRARY_PATH',
          ].includes(k),
      ))
  )
    throw new Error('Invalid extension environment')
  if (value.arguments !== undefined && !strings(value.arguments))
    throw new Error('Invalid extension arguments')
  if (
    value.execution_source !== undefined &&
    !['checkout', 'accepted_runtime'].includes(String(value.execution_source))
  )
    throw new Error('Invalid execution source')
  for (const name of ['manifest', 'executable', 'owner_manifest']) {
    const path = value[name]
    if (
      path !== undefined &&
      (typeof path !== 'string' ||
        !path ||
        isAbsolute(path) ||
        path.includes('\\') ||
        path.split('/').includes('..'))
    )
      throw new Error('Invalid relative extension path')
  }
  return value as unknown as Binding
}
function parseManifest(value: unknown, binding: Binding): Manifest {
  if (
    !object(value) ||
    value.id !== binding.id ||
    value.owner !== binding.owner ||
    value.namespace !== binding.namespace ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(String(value.version)) ||
    !Array.isArray(value.st_contract_versions) ||
    !value.st_contract_versions.every((n) => Number.isInteger(n) && Number(n) > 0) ||
    !strings(value.effects) ||
    !object(value.help) ||
    typeof value.help[''] !== 'string' ||
    !Array.isArray(value.usage)
  )
    throw new Error('Invalid extension manifest')
  if (!Object.values(value.help).every((x) => typeof x === 'string'))
    throw new Error('Invalid help')
  return value as unknown as Manifest
}
export function catalog(data: string, state: string, core: Set<string>): Extension[] {
  const registry = JSON.parse(readFileSync(join(data, 'extensions.json'), 'utf8'))
  if (registry.contractVersion !== 1 || !Array.isArray(registry.bindings))
    throw new Error('Unsupported extension registry version')
  const bindings = registry.bindings.map(parseBinding) as Binding[]
  return bindings.map((binding) => {
    let manifest = parseManifest(
      JSON.parse(
        readFileSync(
          inside(join(data, 'extensions'), binding.manifest.replace(/^extensions\//, '')),
          'utf8',
        ),
      ),
      binding,
    )
    if (binding.owner_manifest && binding.owner !== 'neri') {
      try {
        manifest = parseManifest(
          JSON.parse(
            readFileSync(
              inside(
                join(state, 'projects', binding.owner, 'current/source'),
                binding.owner_manifest,
              ),
              'utf8',
            ),
          ),
          binding,
        )
      } catch {
        /* Bundled manifest is the passive fallback. */
      }
    }
    const collision =
      core.has(binding.namespace) ||
      bindings.filter((b) => b.id === binding.id || b.namespace === binding.namespace).length > 1
    return {
      binding,
      manifest,
      status: collision
        ? 'collision'
        : !manifest.st_contract_versions.includes(1)
          ? 'incompatible'
          : !binding.grant.enabled ||
              manifest.effects.some((x) => !binding.grant.effects.includes(x))
            ? 'denied'
            : 'unverified',
    }
  })
}
export function executable(
  extension: Extension,
  projectRoot: string | undefined,
  state: string,
): string {
  if (extension.status !== 'unverified')
    throw new Error(`Extension ${extension.binding.namespace}: ${extension.status}`)
  const b = extension.binding
  let root = projectRoot
  if (b.execution_source === 'accepted_runtime') {
    const owner = join(state, 'projects', b.owner)
    root = realpathSync(join(owner, 'current/source'))
    if (relative(realpathSync(join(owner, 'releases')), root).startsWith('..'))
      throw new Error('Owner runtime is outside its accepted releases')
  }
  if (!root) throw new Error(`Owner ${b.owner} has no registered root`)
  const path = inside(root, b.executable)
  if (!statSync(path).isFile() || !(statSync(path).mode & 0o111))
    throw new Error(`Install executable for ${b.owner}: ${b.executable}`)
  return path
}
export function passiveHelp(extension: Extension, argv: string[]): string | null {
  if (!argv.length) return extension.manifest.help['']
  if (!argv.includes('--help') && !argv.includes('-h')) return null
  const path: string[] = []
  let route = '',
    nearest = ''
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') return null
    if (arg === '--help' || arg === '-h')
      return (
        extension.manifest.help[route] ??
        (extension.binding.owner_help ? null : extension.manifest.help[nearest])
      )
    if (arg.startsWith('-')) {
      const arity = extension.manifest.help_options?.[route]?.[arg.split('=')[0]]
      if (arity === undefined)
        return extension.binding.owner_help ? null : extension.manifest.help[nearest]
      i += arg.includes('=') ? Math.max(0, arity - 1) : arity
    } else {
      path.push(arg)
      route = path.join(' ')
      if (extension.manifest.help[route]) nearest = route
    }
  }
  return null
}
export const extensionEnvironment = (
  binding: Binding,
  env: NodeJS.ProcessEnv,
  context: unknown,
): NodeJS.ProcessEnv => {
  const allowed = new Set([
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    ...(binding.environment ?? []),
  ])
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key))),
    ST_EXTENSION_CONTEXT: JSON.stringify(context),
  }
}
