// The package graph, read from packages/*/package.json. Layers, the exact
// packages each may import (`aico.imports`), DB files and workspace dependencies are data there; the boundary
// rules, boundaries.mjs and the generated check stages all read this.
const fs = require('node:fs')
const path = require('node:path')

function loadPackages(root = path.resolve(__dirname, '..')) {
  const base = path.join(root, 'packages')
  const packages = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(base, entry.name, 'package.json')))
    .map((entry) => {
      const json = JSON.parse(fs.readFileSync(path.join(base, entry.name, 'package.json'), 'utf8'))
      const aico = json.aico ?? {}
      return {
        dir: entry.name,
        name: json.name,
        json,
        layer: aico.layer,
        browser: aico.browser === true,
        imports: aico.imports ?? [],
        db: aico.db ?? [],
        deps: [],
      }
    })
    .sort((a, b) => a.dir.localeCompare(b.dir))
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  for (const pkg of packages) {
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    const names = declared.flatMap((field) => Object.keys(pkg.json[field] ?? {}))
    pkg.deps = [...new Set(names)].filter((name) => byName.has(name)).sort()
  }
  return packages
}

// The one same-layer import the rules allow (root package.json aico.sameLayerImports):
// { '@aico/web-frontend': ['@aico/ui-kit'] }.
function sameLayerImports(root = path.resolve(__dirname, '..')) {
  const json = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  return json.aico?.sameLayerImports ?? {}
}

// The package and every workspace package it depends on, directly or not.
function cone(packages, pkg) {
  const byName = new Map(packages.map((item) => [item.name, item]))
  const seen = new Set()
  const visit = (item) => {
    if (seen.has(item.name)) return
    seen.add(item.name)
    for (const dep of item.deps) visit(byName.get(dep))
  }
  visit(pkg)
  return packages.filter((item) => seen.has(item.name))
}

// Root files every package's checks depend on.
const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'vitest.config.ts',
  'biome.json',
]

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', '.tsbuild', '.venv', '__pycache__'])
const SOURCE = /\.(ts|tsx|mjs|cjs|css|py|sh)$/

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (SOURCE.test(entry.name)) yield full
  }
}

// Who reads the fixtures in contracts/: every package and native dir with a
// source or test file naming `contracts/<file>`. Returns
// [{ kind: 'package' | 'native', dir, file: 'contracts/x.json', readers: ['rel/path'] }].
function contractReaders(root = path.resolve(__dirname, '..')) {
  const fixtures = fs.existsSync(path.join(root, 'contracts'))
    ? fs.readdirSync(path.join(root, 'contracts')).map((name) => `contracts/${name}`)
    : []
  const found = new Map()
  for (const kind of ['package', 'native']) {
    const base = path.join(root, kind === 'package' ? 'packages' : 'native')
    if (!fs.existsSync(base)) continue
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const file of walk(path.join(base, entry.name))) {
        const text = fs.readFileSync(file, 'utf8')
        for (const fixture of fixtures) {
          if (!text.includes(fixture)) continue
          const key = `${kind}:${entry.name}:${fixture}`
          const row = found.get(key) ?? { kind, dir: entry.name, file: fixture, readers: [] }
          row.readers.push(path.relative(root, file))
          found.set(key, row)
        }
      }
    }
  }
  return { fixtures, readers: [...found.values()] }
}

module.exports = { loadPackages, sameLayerImports, cone, contractReaders, ROOT_FILES, walk }
