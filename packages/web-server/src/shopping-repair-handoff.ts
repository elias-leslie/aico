import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Agent handoffs are proposals. All identities and changed paths are checked
// against Git; neither the report nor a successful agent turn is a check receipt.

interface Runner {
  run(argv: string[], cwd?: string): Promise<{ code: number; output: string }>
}

export interface ShoppingHandoff {
  base: string
  commit: string
  files: string[]
  requests: string[]
}

const SHA = /^[a-f0-9]{40}$/
const REQUEST = /^[A-Za-z0-9_-]{1,100}$/

function pathOkay(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    [...path].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    path.split('/').every((part) => !!part && part !== '.' && part !== '..' && part !== '.git')
  )
}

export async function validateShoppingHandoff(
  io: Runner,
  worktree: string,
  expectedBase: string,
  expectedRequests: string[],
  proposed: unknown,
): Promise<ShoppingHandoff | undefined> {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return undefined
  const value = proposed as Record<string, unknown>
  if (
    value.version !== 1 ||
    value.base !== expectedBase ||
    !SHA.test(expectedBase) ||
    typeof value.commit !== 'string' ||
    !SHA.test(value.commit) ||
    value.commit === expectedBase ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    !value.files.every((p) => typeof p === 'string' && pathOkay(p)) ||
    !Array.isArray(value.requests) ||
    !value.requests.length ||
    !value.requests.every((r) => typeof r === 'string' && REQUEST.test(r))
  )
    return undefined
  const files = value.files as string[]
  const requests = value.requests as string[]
  if (
    new Set(files).size !== files.length ||
    new Set(requests).size !== requests.length ||
    requests.length !== new Set(expectedRequests).size ||
    requests.some((id) => !expectedRequests.includes(id))
  )
    return undefined
  const [parents, tree, changes] = await Promise.all([
    io.run(['git', '-C', worktree, 'rev-list', '--parents', value.commit, `^${expectedBase}`]),
    io.run(['git', '-C', worktree, 'ls-tree', '-r', '-z', value.commit, '--', ...files]),
    io.run([
      'git',
      '-C',
      worktree,
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      expectedBase,
      value.commit,
      '--',
    ]),
  ])
  if (parents.code || changes.code || tree.code) return undefined
  // Every commit after the pinned base must be a single-parent chain.
  let expected = value.commit
  const chain = parents.output.trim().split('\n')
  for (const line of chain) {
    const parts = line.trim().split(' ')
    if (parts.length !== 2 || parts[0] !== expected || !SHA.test(parts[1] ?? '')) return undefined
    expected = parts[1] as string
  }
  if (expected !== expectedBase) return undefined
  const actual = changes.output.split('\0').filter(Boolean).sort()
  if (
    actual.some((p) => !pathOkay(p)) ||
    JSON.stringify(actual) !== JSON.stringify([...files].sort())
  )
    return undefined
  const entries = tree.output.split('\0').filter(Boolean)
  if (
    entries.some((entry) => {
      const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry)
      return !match || !files.includes(match[2] as string)
    })
  )
    return undefined
  // Keep owner-only operations outside this Shopping repair. The independent
  // gate and deployment placement also cannot be rewritten by its candidate.
  if (
    files.some(
      (path) =>
        /(^|\/)(\.github|\.env[^/]*|[^/]*(credentials?|secrets?|retirement|financial|payment|publish)[^/]*)($|\/)/i.test(
          path,
        ) ||
        path === '.st-check.toml' ||
        path === 'project.identity.json',
    )
  )
    return undefined
  return { base: expectedBase, commit: value.commit, files, requests }
}

/** Re-run the owning full gate and read its retained receipt for the exact tree. */
export async function acceptShoppingHandoff(
  io: Runner,
  projectRoot: string,
  commit: string,
): Promise<{ tree: string; receipt: string } | undefined> {
  if (!SHA.test(commit)) return undefined
  const [treeResult, commonResult] = await Promise.all([
    io.run(['git', '-C', projectRoot, 'rev-parse', '--verify', `${commit}^{tree}`]),
    io.run(['git', '-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
  ])
  const tree = treeResult.output.trim()
  const common = commonResult.output.trim()
  if (treeResult.code || commonResult.code || !SHA.test(tree) || !common.startsWith('/'))
    return undefined
  const checked = await io.run(['st', 'check', '--acceptance', '--sha', commit], projectRoot)
  if (checked.code !== 0) return undefined
  const receipt = join(common, 'aico-checks', 'receipts', `accept-${tree}.json`)
  try {
    const value = JSON.parse(readFileSync(receipt, 'utf8')) as Record<string, unknown>
    if (
      value.passed !== true ||
      value.scope !== null ||
      value.tree !== tree ||
      !Array.isArray(value.results)
    )
      return undefined
    return { tree, receipt }
  } catch {
    return undefined
  }
}
