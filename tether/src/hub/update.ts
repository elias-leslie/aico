// Remote Tether updates (docs/plans/remote-hosts.md "Updates"). A peer whose
// health names an older `apiVersion` than this hub gets this hub's installed
// release over the link's ssh ControlMaster: the release files go as one tar
// stream, the host installs them with the release's own install-release.sh
// into its ~/.local/lib/tether, and tether@<instance> restarts there. When the
// restarted Tether does not answer within the bound, the host puts its
// previous bundle and launcher back and restarts on them. Nothing here powers
// a host on: a host that is off is updated when its link next comes up.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isInstanceName } from '../config'
import { type RunResult, remoteArgv, shellQuote } from './host-admin'
import type { HostEntry } from './hosts'

/** What an installed release holds (scripts/install-release.sh puts them
 * there), as paths inside it. */
export const RELEASE_FILES = [
  'dist/tether.mjs',
  'bin/tether',
  'scripts/install-release.sh',
  'scripts/install-shims.sh',
  'scripts/aico-root-watch.py',
  'scripts/aico-blank-slate',
  'shims/tether-shim',
  'shims/shims.list',
]

/** How long the copy, install, restart and rollback may take in all. */
export const UPDATE_RUN_MS = 240_000
/** How long the host's restarted Tether has to answer before rollback. */
export const UPDATE_ANSWER_SEC = 90

export interface UpdateTarget {
  entry: HostEntry
  /** The link's ssh ControlMaster socket. */
  control: string
  /** The remote Tether's instance, from its health answer. */
  instance: string | null
}

export type Updater = (target: UpdateTarget) => Promise<RunResult>

/** The installed release this process runs from (`<dir>/dist/tether.mjs`),
 * or null when it runs from anywhere else (a test, a source checkout). */
export function runningRelease(bundle: string | undefined = process.argv[1]): string | null {
  if (!bundle || basename(bundle) !== 'tether.mjs' || basename(dirname(bundle)) !== 'dist')
    return null
  return dirname(dirname(bundle))
}

/** The shell line the host runs with the release's tar on stdin. */
export function updateLine(
  instance: string,
  socket: string,
  answerSec: number = UPDATE_ANSWER_SEC,
): string {
  const keep = 'dist/tether.mjs bin/tether'
  return [
    'set -eu',
    `instance=${shellQuote(instance)}`,
    `socket=${shellQuote(socket)}`,
    // The stable path tether@.service runs from.
    'lib="$HOME/.local/lib/tether"',
    'stage=$(mktemp -d -t tether-update.XXXXXX)',
    `trap 'rm -rf "$stage"' EXIT`,
    'mkdir "$stage/new" "$stage/old"',
    'tar -xf - -C "$stage/new"',
    // install-release.sh reads the shims where a checkout keeps them.
    'mkdir -p "$stage/new/scripts/shims"',
    'mv "$stage/new/shims/tether-shim" "$stage/new/shims/shims.list" "$stage/new/scripts/shims/"',
    `for file in ${keep}; do`,
    '  if [ -f "$lib/$file" ]; then mkdir -p "$stage/old/$(dirname "$file")"; cp -p "$lib/$file" "$stage/old/$file"; fi',
    'done',
    'answers() {',
    '  i=0',
    `  while [ "$i" -lt ${answerSec} ]; do`,
    '    TETHER_SOCKET="$socket" "$lib/bin/tether" --instance "$instance" --json version >/dev/null 2>&1 && return 0',
    '    i=$((i + 1))',
    '    sleep 1',
    '  done',
    '  return 1',
    '}',
    'restarted=0',
    'why="its install failed"',
    'if TETHER_LIB_DIR="$lib" bash "$stage/new/scripts/install-release.sh" >/dev/null; then',
    '  why="tether@$instance did not restart"',
    '  if systemctl --user --no-ask-password restart "tether@$instance"; then',
    '    restarted=1',
    `    why="the new release did not answer within ${answerSec} s"`,
    '    if answers; then exit 0; fi',
    '  fi',
    'fi',
    `for file in ${keep}; do`,
    '  if [ -f "$stage/old/$file" ]; then cp -p "$stage/old/$file" "$lib/$file.rollback" && mv -f "$lib/$file.rollback" "$lib/$file"; fi',
    'done',
    'if [ "$restarted" = 1 ]; then systemctl --user --no-ask-password restart "tether@$instance" || true; fi',
    'echo "$why; the previous release is back" >&2',
    'exit 1',
  ].join('\n')
}

/** Copy `release` to the host and install it there (see the file comment).
 * `argv` stands in for the ssh command in tests. */
export function pushRelease(
  release: string | null,
  target: UpdateTarget,
  options: { timeoutMs?: number; argv?: string[] } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? UPDATE_RUN_MS
  const fail = (output: string) => Promise.resolve({ code: null, stdout: '', output })
  if (!release) return fail('this Tether does not run from an installed release')
  const missing = RELEASE_FILES.filter((file) => !existsSync(join(release, file)))
  if (missing.length)
    return fail(`this Tether's release at ${release} has no ${missing.join(', ')}`)
  const instance = target.instance
  if (!instance || !isInstanceName(instance))
    return fail(`the host's Tether named no usable instance (${JSON.stringify(instance)})`)
  const argv =
    options.argv ??
    remoteArgv(target.entry, target.control, updateLine(instance, target.entry.socket))
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const tar = spawn('tar', ['-cf', '-', ...RELEASE_FILES], {
      cwd: release,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [command, ...args] = argv as [string, ...string[]]
    const ssh = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    const done = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tar.kill('SIGKILL')
      resolve(result)
    }
    const timer = setTimeout(() => {
      ssh.kill('SIGKILL')
      done({ code: null, stdout: '', output: `timed out after ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)
    const keep = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_096)
    }
    tar.stderr.on('data', keep)
    ssh.stderr.on('data', keep)
    tar.stdout.pipe(ssh.stdin)
    // ssh gone early (a dropped master): tar's write fails; ssh's exit says why.
    ssh.stdin.on('error', () => {})
    tar.once('error', (error) => {
      ssh.kill('SIGKILL')
      done({ code: null, stdout: '', output: `tar: ${error.message}` })
    })
    ssh.once('error', (error) => done({ code: null, stdout: '', output: error.message }))
    ssh.once('close', (code) => {
      const lines = stderr.trim().split('\n')
      const last = (lines[lines.length - 1] ?? '').trim().slice(0, 300)
      done({ code, stdout: '', output: last || `exit ${code ?? 'error'}` })
    })
  })
}
