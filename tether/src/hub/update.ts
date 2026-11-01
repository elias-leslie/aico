// Remote Tether updates (docs/plans/remote-hosts.md "Updates"). A peer whose
// health names an older `apiVersion` than this hub gets this hub's installed
// release over the link's ssh ControlMaster: the release files go as one tar
// stream, the host installs them with the release's own install-release.sh
// into its ~/.local/lib/tether, and tether@<instance> restarts there. The
// restart is a stop, a copy of the instance's database (with its WAL), then a
// start: a new release migrates the database as it starts, and an older one
// refuses a newer schema. When the restarted Tether does not answer within the
// bound, the host stops it, puts its previous bundle, launcher and database
// back and starts on them. One update runs on a host at a time (a flock).
// Nothing here powers a host on: a host that is off is updated when its link
// next comes up.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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

/** How long the copy, install, restart and rollback may take in all: two
 * answer waits, two stops and the copies. */
export const UPDATE_RUN_MS = 300_000
/** How long the host's restarted Tether has to answer before rollback, and
 * the rolled-back one after it. */
export const UPDATE_ANSWER_SEC = 90
/** The host script's exit when another update holds the host's lock. */
export const UPDATE_BUSY_EXIT = 75
/** The line the host script prints just before it installs anything. */
export const UPDATE_INSTALLING = 'tether-update: installing'

/** Whether the host began installing: a failure after that (the install, the
 * restart or the rollback) would happen again on this release, while one
 * before it (no ssh, a dropped link, a held lock) is worth another try. */
export function installStarted(result: RunResult): boolean {
  return result.stdout.split('\n').includes(UPDATE_INSTALLING)
}

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

/** Which release this hub runs, as a short hash of its bundle: a failed
 * update is tried again only once it changes. `none` when there is no
 * installed release (nothing can be sent then anyway). */
export function releaseId(release: string | null): string {
  if (!release) return 'none'
  try {
    const bundle = readFileSync(join(release, 'dist', 'tether.mjs'))
    return createHash('sha256').update(bundle).digest('hex').slice(0, 16)
  } catch {
    return 'none'
  }
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
    'unit="tether@$instance"',
    // The stable path tether@.service runs from, and the instance's database
    // where src/config.ts resolvePaths puts it (production units override neither).
    'lib="$HOME/.local/lib/tether"',
    `state="\${XDG_STATE_HOME:-$HOME/.local/state}/tether/$instance"`,
    'mkdir -p "$lib"',
    'command -v flock >/dev/null || { echo "the host has no flock" >&2; exit 1; }',
    'exec 9>"$lib/.update.lock"',
    `flock -n 9 || { echo "another update of this host's Tether is still running" >&2; exit ${UPDATE_BUSY_EXIT}; }`,
    'stage=$(mktemp -d -t tether-update.XXXXXX)',
    `trap 'rm -rf "$stage"' EXIT`,
    'mkdir "$stage/new" "$stage/old" "$stage/db"',
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
    // Taken while Tether is stopped, so the copy is whole. The -shm index is
    // rebuilt from the WAL when the database next opens.
    'save_db() {',
    '  for name in tether.db tether.db-wal; do',
    '    if [ -f "$state/$name" ]; then cp -p "$state/$name" "$stage/db/$name" || return 1; fi',
    '  done',
    '}',
    'restore_db() {',
    '  for name in tether.db tether.db-wal; do',
    '    if [ -f "$stage/db/$name" ]; then cp -p "$stage/db/$name" "$state/$name.rollback" || return 1; fi',
    '  done',
    '  for name in tether.db tether.db-wal; do',
    '    if [ -f "$stage/db/$name" ]; then mv -f "$state/$name.rollback" "$state/$name"; else rm -f "$state/$name"; fi',
    '  done',
    '  rm -f "$state/tether.db-shm"',
    '}',
    'stopped=0',
    'saved=0',
    'why="its install failed"',
    `echo ${shellQuote(UPDATE_INSTALLING)}`,
    'if TETHER_LIB_DIR="$lib" bash "$stage/new/scripts/install-release.sh" >/dev/null; then',
    '  why="$unit did not stop"',
    '  if systemctl --user --no-ask-password stop "$unit"; then',
    '    stopped=1',
    '    why="its database could not be copied"',
    '    if save_db; then',
    '      saved=1',
    '      why="$unit did not start"',
    '      if systemctl --user --no-ask-password start "$unit"; then',
    `        why="the new release did not answer within ${answerSec} s"`,
    '        if answers; then exit 0; fi',
    '      fi',
    '    fi',
    '  fi',
    'fi',
    'if [ "$stopped" = 1 ]; then systemctl --user --no-ask-password stop "$unit" || true; fi',
    `for file in ${keep}; do`,
    '  if [ -f "$stage/old/$file" ]; then cp -p "$stage/old/$file" "$lib/$file.rollback" && mv -f "$lib/$file.rollback" "$lib/$file"; fi',
    'done',
    'back="the previous release is back"',
    'if [ "$saved" = 1 ]; then',
    '  if restore_db; then',
    '    if [ -f "$stage/db/tether.db" ]; then back="the previous release and its database are back"; fi',
    '  else',
    // The new release may have moved the schema past what the old one reads:
    // never start it on that. The copy stays for whoever repairs the host.
    `    trap - EXIT`,
    '    echo "$why; its database could not be put back (a copy is in $stage/db), so $unit stays stopped" >&2',
    '    exit 1',
    '  fi',
    'fi',
    'if [ "$stopped" = 1 ]; then',
    '  systemctl --user --no-ask-password start "$unit" || true',
    `  answers || back="$back but did not answer within ${answerSec} s either"`,
    'fi',
    'echo "$why; $back" >&2',
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
    let stdout = ''
    let settled = false
    const tar = spawn('tar', ['-cf', '-', ...RELEASE_FILES], {
      cwd: release,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [command, ...args] = argv as [string, ...string[]]
    const ssh = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const done = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tar.kill('SIGKILL')
      resolve(result)
    }
    const timer = setTimeout(() => {
      ssh.kill('SIGKILL')
      done({ code: null, stdout, output: `timed out after ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)
    const keep = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_096)
    }
    ssh.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-4_096)
    })
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
      done({ code, stdout, output: last || `exit ${code ?? 'error'}` })
    })
  })
}
