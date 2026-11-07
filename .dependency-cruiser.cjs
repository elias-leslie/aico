// Package boundaries (docs/plans/codebase-cleanup/cutlist.md 1.1-1.2). Every
// rule reads packages/*/package.json: `aico.layer`, `aico.imports` (the exact
// packages it may import), `aico.browser` and `aico.db`. Known violations
// live in .dependency-cruiser-known-violations.json; new ones fail.
const { loadPackages } = require('./scripts/packages.cjs')

const packages = loadPackages(__dirname)
const inside = (list) => `^packages/(${list.map((pkg) => pkg.dir).join('|')})/`
const importRules = []
for (const pkg of packages) {
  // cutlist 1.1 "may import": exactly the packages in `aico.imports`. boundaries.mjs
  // keeps that list to lower layers (plus the one declared same-layer pair), so this
  // one rule also enforces layer-down-only and "deployables never import each other".
  const targets = packages.filter((other) => other.dir !== pkg.dir && !pkg.imports.includes(other.name))
  if (targets.length === 0) continue
  importRules.push({
    name: 'package-imports-allowlist',
    severity: 'error',
    comment: `${pkg.name} (layer ${pkg.layer}) imports only ${pkg.imports.join(', ') || 'no other package'} (package.json aico.imports, cutlist 1.1 "may import")`,
    from: { path: inside([pkg]) },
    to: { path: inside(targets) },
  })
}

// Node's built-in module names (with and without the node: prefix), as depcruise sees them.
const nodeBuiltins = `^(node:)?(${require('node:module').builtinModules.filter((name) => !name.startsWith('_')).join('|')})$`
const browser = packages.filter((pkg) => pkg.browser)
const servers = packages.filter((pkg) => pkg.layer === 5)
// Tests, configs and build scripts run in Node; only shipped source is held to the browser rules.
const notShippedSource = '\\.(test|spec)\\.[cm]?[jt]sx?$|\\.config\\.[cm]?[jt]s$|/(scripts|test-stubs)/|vitest\\.setup'

module.exports = {
  forbidden: [
    ...importRules,
    {
      name: 'package-name-imports-only',
      severity: 'error',
      comment: 'Packages import each other by package name through its exports, never by a relative path into another package.',
      from: { path: '^packages/([^/]+)/' },
      to: { path: '^packages/', pathNot: '^packages/$1/', dependencyTypes: ['local'] },
    },
    {
      name: 'no-cycles',
      severity: 'error',
      comment: 'No circular imports.',
      from: { pathNot: '^packages/tether/' },
      to: { circular: true },
    },
    {
      name: 'tether-no-cycles',
      severity: 'error',
      comment:
        'Tether has no import cycles, value or type-only (tsPreCompilationDeps counts `import type`), and none is baselined (engine-split plan M0). Break one with a small type file both sides import.',
      from: { path: '^packages/tether/' },
      to: { circular: true },
    },
    {
      name: 'only-store-imports-sqlite',
      severity: 'error',
      comment: 'Only the store package touches node:sqlite.',
      from: { pathNot: '^packages/store/' },
      to: { dependencyTypes: ['core'], path: '^(node:)?sqlite$' },
    },
    ...(browser.length
      ? [
          {
            name: 'browser-code-reaches-no-node-builtins',
            severity: 'error',
            comment: 'Browser packages run in the browser: no node:* modules in shipped source, directly or through any file it imports (also in another package).',
            from: { path: inside(browser), pathNot: notShippedSource },
            to: { path: nodeBuiltins, reachable: true },
          },
          {
            name: 'browser-code-no-server-packages',
            severity: 'error',
            comment: 'Browser packages never import a server package (layer 5).',
            from: { path: inside(browser) },
            to: { path: inside(servers) },
          },
        ]
      : []),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.next|\\.tsbuild|dist|out)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'packages/web-frontend/tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
