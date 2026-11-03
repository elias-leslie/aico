// Repo rules that dependency-cruiser cannot see (docs/plans/codebase-cleanup/cutlist.md 1.2):
//   * every package has an aico.layer, and aico.allow names real packages
//   * every dependency is exactly pinned
//   * one owner per DB file: package.json aico.db, and non-test source names no other .db
//   * source imports only workspace packages its package.json declares
//   * every file in contracts/ is read by a test
//   * the generated check stages and Biome overrides are current
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stale } from './check-stages.mjs'

const { loadPackages, contractReaders, walk } = createRequire(import.meta.url)('./packages.cjs')
const root = fileURLToPath(new URL('..', import.meta.url))
const packages = loadPackages(root)
const problems = []
const fail = (message) => problems.push(message)

const exact = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|file:.+)$/
const isTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$|\/tests?\/|test-stubs/.test(file)
const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const rootJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const [owner, json] of [['root', rootJson], ...packages.map((pkg) => [pkg.name, pkg.json])]) {
  for (const field of fields) {
    for (const [name, version] of Object.entries(json[field] ?? {})) {
      if (!exact.test(version))
        fail(`${owner}: ${field} ${name} is "${version}", pin an exact version`)
    }
  }
}

const names = new Set(packages.map((pkg) => pkg.name))
const dbOwner = new Map()
for (const pkg of packages) {
  if (!Number.isInteger(pkg.layer)) fail(`${pkg.name}: package.json needs aico.layer`)
  for (const name of pkg.allow)
    if (!names.has(name)) fail(`${pkg.name}: aico.allow names unknown package ${name}`)
  for (const db of pkg.db) {
    if (dbOwner.has(db)) fail(`DB file ${db} is declared by ${dbOwner.get(db)} and ${pkg.name}`)
    dbOwner.set(db, pkg.name)
  }
}

const dbName = /(?<=['"`/])[A-Za-z0-9_-]+\.db\b/g
const workspaceImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](@aico\/[a-z0-9-]+)/g
for (const pkg of packages) {
  for (const file of walk(`${root}/packages/${pkg.dir}`)) {
    const rel = file.slice(root.length + 1)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(workspaceImport)) {
      if (match[1] !== pkg.name && !pkg.deps.includes(match[1]))
        fail(`${rel}: imports ${match[1]}, which ${pkg.name}/package.json does not declare`)
    }
    if (isTest(rel) || !/\.[cm]?[jt]sx?$/.test(rel)) continue
    for (const db of new Set(text.match(dbName) ?? [])) {
      if (!pkg.db.includes(db))
        fail(
          `${rel}: names DB file ${db}; ${pkg.name} declares ${pkg.db.join(', ') || 'none'} (package.json aico.db)`,
        )
    }
  }
}

// Only what reads contracts/ today: each fixture needs a reading test.
const { fixtures, readers } = contractReaders(root)
for (const fixture of fixtures) {
  const tests = readers
    .filter((row) => row.file === fixture)
    .flatMap((row) => row.readers)
    .filter(isTest)
  if (tests.length === 0) fail(`${fixture}: no test reads it`)
}

for (const file of stale())
  fail(`${file}: generated from package data and out of date, run npm run check-stages`)

if (problems.length) {
  console.error(
    `boundaries: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}`,
  )
  process.exit(1)
}
console.log(`boundaries: ok (${packages.length} packages, ${fixtures.length} contract fixtures)`)
