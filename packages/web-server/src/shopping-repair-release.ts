import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShoppingPolicy } from './shopping-repair-policy'
import { deployedShoppingCommit } from './shopping-repair-worktree'

interface Runner {
  run(argv: string[], cwd?: string): Promise<{ code: number; output: string }>
}

// Match the managed service runner's user-bus discovery when a caretaker was
// started without the usual login-session variables. The command still goes
// through PATH and any installed systemd shims.
function userSystemd(argv: string[]): string[] {
  const uid = process.getuid?.()
  const runtime = process.env.XDG_RUNTIME_DIR || (uid === undefined ? '' : `/run/user/${uid}`)
  const bus = runtime ? join(runtime, 'bus') : ''
  if (!runtime || !existsSync(bus)) return argv
  return [
    'env',
    `XDG_RUNTIME_DIR=${runtime}`,
    `DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${bus}`}`,
    ...argv,
  ]
}

export async function startShoppingRelease(
  io: Runner,
  _projectRoot: string,
  worktree: string,
  releaseWorktree: string,
  base: string,
  commit: string,
  unit: string,
  policy?: ShoppingPolicy,
): Promise<boolean> {
  if (!/^shopping-repair-[0-9a-f-]+$/.test(unit) || !/^[0-9a-f]{40}$/.test(commit)) return false
  const [head, dirty, releaseHead, releaseDirty] = await Promise.all([
    io.run(['git', '-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}']),
    io.run(['git', '-C', worktree, 'status', '--porcelain', '--untracked-files=all']),
    io.run(['git', '-C', releaseWorktree, 'rev-parse', '--verify', 'HEAD^{commit}']),
    io.run(['git', '-C', releaseWorktree, 'status', '--porcelain', '--untracked-files=all']),
  ])
  if (
    head.code ||
    head.output.trim() !== commit ||
    dirty.code ||
    dirty.output.trim() ||
    releaseHead.code ||
    releaseHead.output.trim() !== base ||
    releaseDirty.code ||
    releaseDirty.output.trim()
  )
    return false
  if (policy?.release === 'dadbot') {
    // Older scripts ignore unknown arguments and would deploy. Inspect the
    // trusted base script before invoking its side-effect-free capability mode.
    const script = join(releaseWorktree, 'scripts/deploy.sh')
    try {
      if (!readFileSync(script, 'utf8').includes('expected-base-v1')) return false
    } catch {
      return false
    }
    const capability = await io.run(['bash', script, 'capabilities'])
    if (capability.code || capability.output.trim() !== 'expected-base-v1') return false
  }
  if (!policy || policy.release === 'portfolio') {
    const capability = await io.run([
      join(releaseWorktree, 'scripts/vm-release.sh'),
      'capabilities',
    ])
    if (capability.code !== 0 || capability.output.trim() !== 'expected-base-v1') return false
  }
  if ((await deployedShoppingCommit(io, releaseWorktree, policy)) !== base) return false
  return true
}

export async function dispatchShoppingRelease(
  io: Runner,
  worktree: string,
  commit: string,
  base: string,
  unit: string,
  sshAuthSock: string,
  policy?: ShoppingPolicy,
  receipt?: string,
): Promise<boolean> {
  if (
    !/^shopping-repair-[0-9a-f-]+$/.test(unit) ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !/^[0-9a-f]{40}$/.test(base) ||
    !sshAuthSock.startsWith('/') ||
    /[\r\n\0]/.test(sshAuthSock)
  )
    return false
  let command: string[]
  if (policy?.release === 'dadbot') {
    // Execute the base's script, but archive the accepted commit from the release checkout.
    command = [
      'bash',
      '-c',
      'set -eu; git -C "$1" checkout --detach "$2"; git -C "$1" show "$3:scripts/deploy.sh" > "$1/scripts/deploy.sh"; exec bash "$1/scripts/deploy.sh" --expected-base "$3"',
      'shopping-release',
      worktree,
      commit,
      base,
    ]
  } else if (policy?.release === 'managed') {
    const common = await io.run([
      'git',
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    if (common.code || !common.output.trim().startsWith('/') || !receipt?.startsWith('/'))
      return false
    // The service source checkout fetches branch refs, while the isolated
    // agent's commit is detached. Retain a unique ref before invoking it.
    command = [
      'bash',
      '-c',
      'set -eu; git -C "$1" update-ref "$2" "$3" 0000000000000000000000000000000000000000; exec st service rebuild "$4" --sha "$3" --source-repo "$5" --acceptance "$6"',
      'shopping-release',
      worktree,
      `refs/heads/shopping-repair/${unit}`,
      commit,
      policy.project,
      common.output.trim(),
      receipt,
    ]
  } else {
    command = [join(worktree, 'scripts/vm-release.sh'), 'deploy', commit, '--expected-base', base]
  }
  const result = await io.run(
    userSystemd([
      'systemd-run',
      '--user',
      `--unit=${unit}`,
      '--remain-after-exit',
      `--setenv=SSH_AUTH_SOCK=${sshAuthSock}`,
      ...command,
    ]),
  )
  return result.code === 0
}

export async function shoppingReleaseResult(
  io: Runner,
  projectRoot: string,
  unit: string,
  commit: string,
  policy?: ShoppingPolicy,
): Promise<'pending' | 'failed' | 'verified'> {
  if (!/^shopping-repair-[0-9a-f-]+$/.test(unit) || !/^[0-9a-f]{40}$/.test(commit)) return 'failed'
  const result = await io.run(
    userSystemd([
      'systemctl',
      '--user',
      'show',
      `${unit}.service`,
      '--no-pager',
      '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID',
    ]),
  )
  if (result.code) return 'pending'
  const fields = Object.fromEntries(
    result.output.split('\n').map((line) => {
      const index = line.indexOf('=')
      return index < 0 ? ['', ''] : [line.slice(0, index), line.slice(index + 1)]
    }),
  )
  if (
    fields.LoadState !== 'loaded' ||
    fields.ActiveState === 'activating' ||
    (fields.ActiveState === 'active' && fields.SubState !== 'exited')
  )
    return 'pending'
  if (
    fields.Result !== 'success' ||
    fields.ExecMainStatus !== '0' ||
    fields.ActiveState !== 'active' ||
    fields.SubState !== 'exited' ||
    fields.MainPID !== '0'
  )
    return 'failed'
  return (await deployedShoppingCommit(io, projectRoot, policy)) === commit ? 'verified' : 'pending'
}
