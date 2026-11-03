// Package boundaries (docs/plans/codebase-cleanup/cutlist.md 1.1-1.2). Every
// rule reads packages/*/package.json: `aico.layer`, `aico.allow` (same-layer
// imports a package may make), `aico.browser` and `aico.db`. Known violations
// live in .dependency-cruiser-known-violations.json; new ones fail.
const { loadPackages } = require('./scripts/packages.cjs')

const packages = loadPackages(__dirname)
const inside = (list) => `^packages/(${list.map((pkg) => pkg.dir).join('|')})/`
const is = (pkg) => (other) => other.dir !== pkg.dir
const layerRules = []
for (const pkg of packages) {
  const allowed = new Set(pkg.allow)
  const rule = (name, comment, targets) => {
    if (targets.length === 0) return
    layerRules.push({
      name,
      severity: 'error',
      comment,
      from: { path: inside([pkg]) },
      to: { path: inside(targets) },
    })
  }
  const others = packages.filter(is(pkg)).filter((other) => !allowed.has(other.name))
  rule(
    'layer-down-only',
    `${pkg.name} (layer ${pkg.layer}) imports only packages in lower layers`,
    others.filter((other) => other.layer > pkg.layer),
  )
  rule(
    pkg.layer === 5 ? 'deployables-never-import-each-other' : 'same-layer-import',
    `${pkg.name} (layer ${pkg.layer}) does not import a package in its own layer; a deployable reaches another over HTTP or its socket`,
    others.filter((other) => other.layer === pkg.layer),
  )
}

const browser = packages.filter((pkg) => pkg.browser)
const servers = packages.filter((pkg) => pkg.layer === 5)
// Tests, configs and build scripts run in Node; only shipped source is held to the browser rules.
const notShippedSource = '\\.(test|spec)\\.[cm]?[jt]sx?$|\\.config\\.[cm]?[jt]s$|/(scripts|test-stubs)/|vitest\\.setup'

module.exports = {
  forbidden: [
    ...layerRules,
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
      from: {},
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
            name: 'browser-code-no-node-builtins',
            severity: 'error',
            comment: 'Browser packages run in the browser: no node:* modules in shipped source.',
            from: { path: inside(browser), pathNot: notShippedSource },
            to: { dependencyTypes: ['core'] },
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
