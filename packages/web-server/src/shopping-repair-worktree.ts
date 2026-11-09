// Prepare an isolated checkout from the actually deployed Portfolio release.
// Never use the shared checkout's HEAD or include its uncommitted changes.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ShoppingPolicy } from './shopping-repair-policy'

interface Runner {
  run(argv: string[]): Promise<{ code: number; output: string }>
}

export async function deployedShoppingCommit(
  io: Runner,
  projectRoot: string,
  policy?: ShoppingPolicy,
): Promise<string | undefined> {
  if (policy?.release === 'dadbot') {
    const result = await io.run([
      'ssh',
      '-o',
      'BatchMode=yes',
      policy.sshHost as string,
      'cat',
      policy.releaseFile as string,
    ])
    if (result.code) return undefined
    try {
      const value = JSON.parse(result.output) as { sha?: unknown }
      if (typeof value.sha !== 'string' || !/^[0-9a-f]{40}$/.test(value.sha)) return undefined
      const resolved = await io.run([
        'git',
        '-C',
        projectRoot,
        'rev-parse',
        '--verify',
        `${value.sha}^{commit}`,
      ])
      return resolved.code === 0 && resolved.output.trim() === value.sha ? value.sha : undefined
    } catch {
      return undefined
    }
  }
  if (policy?.release === 'managed') {
    const status = await io.run(['st', 'service', 'status', policy.project])
    const current =
      status.code === 0
        ? /(?:^|\s)release=([0-9a-f]{12,40})(?:\s|$)/.exec(status.output)?.[1]
        : undefined
    if (!current) return undefined
    const resolved = await io.run([
      'git',
      '-C',
      projectRoot,
      'rev-parse',
      '--verify',
      `${current}^{commit}`,
    ])
    return resolved.code === 0 &&
      /^[0-9a-f]{40}$/.test(resolved.output.trim()) &&
      resolved.output.trim().startsWith(current)
      ? resolved.output.trim()
      : undefined
  }
  const status = await io.run([join(projectRoot, 'scripts/vm-release.sh'), 'status'])
  const current =
    status.code === 0
      ? /^\[guest\] current:\s+\S+\s+([0-9a-f]{12,40})\s*$/m.exec(status.output)?.[1]
      : undefined
  if (!current) return undefined
  const resolved = await io.run([
    'git',
    '-C',
    projectRoot,
    'rev-parse',
    '--verify',
    `${current}^{commit}`,
  ])
  if (resolved.code !== 0 || !/^[0-9a-f]{40}$/.test(resolved.output.trim())) return undefined
  return resolved.output.trim()
}

export async function prepareShoppingWorktree(
  io: Runner,
  projectRoot: string,
  worktree: string,
  commit: string,
): Promise<{ base: string } | undefined> {
  if (!/^[0-9a-f]{40}$/.test(commit)) return undefined
  if (!existsSync(worktree)) {
    const added = await io.run([
      'git',
      '-C',
      projectRoot,
      'worktree',
      'add',
      '--detach',
      worktree,
      commit,
    ])
    if (added.code !== 0 && !existsSync(worktree)) return undefined
  }
  const [head, common, expected, dirty] = await Promise.all([
    io.run(['git', '-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}']),
    io.run(['git', '-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    io.run(['git', '-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    io.run(['git', '-C', worktree, 'status', '--porcelain', '--untracked-files=all']),
  ])
  if (
    head.code ||
    common.code ||
    expected.code ||
    dirty.code ||
    head.output.trim() !== commit ||
    !common.output.trim() ||
    common.output.trim() !== expected.output.trim() ||
    dirty.output.trim()
  )
    return undefined
  return { base: commit }
}
