// Which packages a change touches: changed files (git) -> packages -> every
// package that depends on them. native/<dir> and contracts/ map to their native
// stages. No Nx or Turbo.
//
//   node scripts/affected.mjs [--base REF] [--json] [--files a b ...]
//
// Default: working tree and untracked files against HEAD. A change to a root
// config (tsconfig, package.json, biome.json, ...) or to scripts/ affects all.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { loadPackages, contractReaders, ROOT_FILES } = createRequire(import.meta.url)(
  './packages.cjs',
)
const root = fileURLToPath(new URL('..', import.meta.url))

function changedFiles(base) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  return [
    ...new Set([
      ...git('diff', '--name-only', base),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ]
}

// Returns { packages: ['@aico/x'], native: ['native:host-steward'], all: boolean }.
export function affected(
  files,
  packages = loadPackages(root),
  readers = contractReaders(root).readers,
) {
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg.name]))
  const hit = new Set()
  const native = new Set()
  let all = false
  for (const file of files) {
    const [top, dir] = file.split('/')
    if (top === 'packages' && byDir.has(dir)) hit.add(byDir.get(dir))
    else if (top === 'native' && dir) native.add(`native:${dir}`)
    else if (top === 'contracts') {
      for (const row of readers.filter((item) => item.file === file)) {
        if (row.kind === 'package') hit.add(byDir.get(row.dir))
        else native.add(`native:${row.dir}`)
      }
    } else if (
      ROOT_FILES.includes(file) ||
      top === 'scripts' ||
      file.startsWith('.dependency-cruiser') ||
      file === '.st-check.toml'
    ) {
      all = true
    }
  }
  const closure = new Set(all ? packages.map((pkg) => pkg.name) : hit)
  for (let grew = true; grew; ) {
    grew = false
    for (const pkg of packages) {
      if (!closure.has(pkg.name) && pkg.deps.some((dep) => closure.has(dep)))
        closure.add(pkg.name), (grew = true)
    }
  }
  return { packages: [...closure].sort(), native: [...native].sort(), all }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name) => args.indexOf(name)
  const files =
    flag('--files') >= 0
      ? args.slice(flag('--files') + 1)
      : changedFiles(flag('--base') >= 0 ? args[flag('--base') + 1] : 'HEAD')
  const result = affected(files)
  if (flag('--json') >= 0) console.log(JSON.stringify(result))
  else for (const name of [...result.packages, ...result.native]) console.log(name)
}
