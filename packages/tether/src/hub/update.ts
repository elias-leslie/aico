// Signed releases travel over the fleet link. The receiver verifies before running
// this installer in its own user unit, so restarting Tether cannot kill the install.

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { requestExec } from '@aico/fleet/exec'
import type { HostEntry } from '@aico/fleet/hosts'
import {
  bundleHash,
  DEFAULT_UPDATE_PINS,
  newerRelease,
  RELEASE_FILES,
  type Release,
  readUpdateKeys,
  releaseHash,
  SIGNED_RELEASE,
  stageRelease,
  verifyRelease,
} from '@aico/fleet/releases'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { type RunResult, shellQuote } from './host-admin'
import { tetherHubPorts } from './ports'
import type { HubPorts, ReleaseIdentity } from './types'

/** How long the copy, install, restart and rollback may take in all: two
 * answer waits, two stops and the copies. */
const UPDATE_RUN_MS = 300_000
/** How long the host's restarted Tether has to answer before rollback, and
 * the rolled-back one after it. */
const UPDATE_ANSWER_SEC = 90
/** The host script's exit when another update holds the host's lock. */
export const UPDATE_BUSY_EXIT = 75
/** The line the host script prints just before it installs anything. */
export const UPDATE_INSTALLING = 'tether-update: installing'

/** Whether the host began installing: a failure after that (the install, the
 * restart or the rollback) would happen again on this release, while one
 * before it (no ssh, a dropped link, a held lock) is worth another try. */
export function installStarted(result: RunResult): boolean {
  // Anywhere in stdout: a login profile that prints without a newline would
  // otherwise share the marker's line and hide it.
  return result.stdout.includes(UPDATE_INSTALLING)
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

const identities = new Map<string, ReleaseIdentity | null>()

/** The installed release this process runs from, read once per process (the bundle
 * is what runs, so a later install in the same folder is not it). Null when it runs
 * from anywhere else, or the folder is not a whole release. */
export function installedRelease(dir: string | null = runningRelease()): ReleaseIdentity | null {
  if (!dir) return null
  if (identities.has(dir)) return identities.get(dir) ?? null
  let identity: ReleaseIdentity | null = null
  try {
    const hash = releaseHash(dir)
    let issuedAt: number | null = null
    try {
      const signed = JSON.parse(readFileSync(join(dir, SIGNED_RELEASE), 'utf8')) as {
        payload?: string
      }
      const payload = JSON.parse(signed.payload ?? '{}') as Partial<Release>
      // Only a signature file that describes these files says when they were issued.
      if (payload.releaseHash === hash && Number.isSafeInteger(payload.issuedAt))
        issuedAt = payload.issuedAt as number
    } catch {
      // Unsigned: no deploy order.
    }
    identity = { hash, issuedAt }
  } catch {
    identity = null
  }
  identities.set(dir, identity)
  return identity
}

export type ReleaseAction = 'current' | 'update' | 'defer'

/** Whether a host's Tether should get this hub's release (same API or not).
 * - An API older than the hub's: always `update` (the hub cannot talk to it as it is).
 * - A newer API, or one that names none: `current`, never a downgrade.
 * - The same API: `current` when the host reports the same files, or files issued at
 *   or after this hub's (a standby hub that is behind never pushes over a newer
 *   deploy); otherwise `update`, but `defer` while sessions run there, since the
 *   update restarts its Tether. A host that reports no release (it predates this)
 *   is updated; its own receiver still refuses an older signed release. */
export function releaseAction(
  hub: { api: number; release: ReleaseIdentity | null },
  host: { api: number | null; release: ReleaseIdentity | null; busy: boolean },
): ReleaseAction {
  if (host.api === null || host.api > hub.api) return 'current'
  if (host.api < hub.api) return 'update'
  if (!hub.release) return 'current'
  if (host.release) {
    if (host.release.hash === hub.release.hash) return 'current'
    if (
      host.release.issuedAt !== null &&
      (hub.release.issuedAt === null || host.release.issuedAt >= hub.release.issuedAt)
    )
      return 'current'
  }
  return host.busy ? 'defer' : 'update'
}

/** The shell line the host runs with the release's tar on stdin. */
function updateLine(
  instance: string,
  socket: string,
  answerSec: number = UPDATE_ANSWER_SEC,
  stateDir: string | null = null,
  dbFile: string,
): string {
  const keep = [...RELEASE_FILES, SIGNED_RELEASE].join(' ')
  return [
    'set -eu',
    `instance=${shellQuote(instance)}`,
    `socket=${shellQuote(socket)}`,
    'unit="tether@$instance"',
    // The stable path tether@.service runs from, and the instance's database
    // where src/config.ts resolvePaths puts it (production units override neither).
    'lib="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"',
    // hosts.json `stateDir` replaces ~/.local/state/tether when the host sets it.
    stateDir
      ? `state=${shellQuote(stateDir)}/"$instance"`
      : `state="\${XDG_STATE_HOME:-$HOME/.local/state}/tether/$instance"`,
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
    `  for name in ${dbFile} ${dbFile}-wal; do`,
    '    if [ -f "$state/$name" ]; then cp -p "$state/$name" "$stage/db/$name" || return 1; fi',
    '  done',
    '}',
    'restore_db() {',
    `  for name in ${dbFile} ${dbFile}-wal; do`,
    '    if [ -f "$stage/db/$name" ]; then cp -p "$stage/db/$name" "$state/$name.rollback" || return 1; fi',
    '  done',
    `  for name in ${dbFile} ${dbFile}-wal; do`,
    '    if [ -f "$stage/db/$name" ]; then mv -f "$state/$name.rollback" "$state/$name" || return 1; else rm -f "$state/$name"; fi',
    '  done',
    `  rm -f "$state/${dbFile}-shm"`,
    '}',
    'stopped=0',
    'saved=0',
    'why="its install failed"',
    // No database where this script looks means a rollback could not put it
    // back: stop before anything is installed.
    `[ -f "$state/${dbFile}" ] || { echo "no Tether database at $state; nothing installed" >&2; exit 1; }`,
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
    '  if [ -f "$stage/old/$file" ]; then cp -p "$stage/old/$file" "$lib/$file.rollback" && mv -f "$lib/$file.rollback" "$lib/$file"; elif [ "$file" = signed-update.json ]; then rm -f "$lib/$file"; fi',
    'done',
    'back="the previous release is back"',
    'if [ "$saved" = 1 ]; then',
    '  if restore_db; then',
    `    if [ -f "$stage/db/${dbFile}" ]; then back="the previous release and its database are back"; fi`,
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

/** The result survives Tether's own restart and is fetched over the new connection. */
function jobFile(stateDir: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid update id')
  return join(stateDir, 'updates', 'jobs', `${id}.json`)
}
export function updateResult(id: string, expectedHash: string, env = process.env): RunResult {
  const settings = readSettings(env, '')
  if (!settings || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error('Invalid update result request')
  const file = jobFile(settings.stateDir, id)
  if (!existsSync(file)) return { code: null, stdout: '', output: 'Update is still running' }
  const result = JSON.parse(readFileSync(file, 'utf8')) as RunResult & { releaseHash: string }
  if (result.releaseHash !== expectedHash || !Number.isInteger(result.code))
    throw new Error('Invalid update result')
  const lib = env.TETHER_LIB_DIR || join(env.HOME || homedir(), '.local/lib/tether')
  if (result.code === 0 && releaseHash(lib) !== expectedHash)
    return {
      code: 1,
      stdout: UPDATE_INSTALLING,
      output: 'Installed release does not match the signed update',
    }
  return { code: result.code, stdout: result.stdout, output: result.output }
}
export function receiveUpdate(
  input: string,
  target: { instance: string; socket: string; stateDir: string | null; id: string },
  env = process.env,
  ports: Pick<HubPorts, 'apiVersion' | 'isInstanceName' | 'dbFile'> = tetherHubPorts,
): RunResult {
  if (!ports.isInstanceName(target.instance) || !target.socket.startsWith('/'))
    throw new Error('Invalid update target')
  const settings = readSettings(env, '')
  if (!settings) throw new Error('Fleet is not configured')
  const keys = readUpdateKeys(settings.updatePins || DEFAULT_UPDATE_PINS)
  const candidate = verifyRelease(input, keys)
  const lib = env.TETHER_LIB_DIR || join(env.HOME || homedir(), '.local/lib/tether')
  const installedFile = join(lib, SIGNED_RELEASE)
  const installed = existsSync(installedFile)
    ? verifyRelease(readFileSync(installedFile, 'utf8'), keys)
    : undefined
  if (!newerRelease(candidate, ports.apiVersion, releaseHash(lib), installed))
    return { code: 0, stdout: 'Already installed', output: '' }
  const resultFile = jobFile(settings.stateDir, target.id)
  if (existsSync(resultFile)) return updateResult(target.id, candidate.releaseHash, env)
  const stage = stageRelease(input, join(settings.stateDir, 'updates'), keys)
  const archive = join(stage, 'release.tar')
  if (
    spawnSync('tar', ['-cf', archive, ...RELEASE_FILES, SIGNED_RELEASE], { cwd: stage }).status !==
    0
  )
    throw new Error('Could not stage the signed release')
  const script = join(stage, 'install.sh')
  const log = join(stage, 'install.log')
  writeFileSync(
    script,
    updateLine(target.instance, target.socket, undefined, target.stateDir, ports.dbFile),
    {
      mode: 0o700,
    },
  )
  mkdirSync(dirname(resultFile), { recursive: true, mode: 0o700 })
  const report = [
    `bash ${shellQuote(script)} < ${shellQuote(archive)} > ${shellQuote(log)} 2>&1`,
    'code=$?',
    `python3 - ${shellQuote(resultFile)} ${shellQuote(log)} "$code" ${shellQuote(candidate.releaseHash)} <<'PY'`,
    'import json, os, shutil, sys',
    'from pathlib import Path',
    'path, log, code, digest = sys.argv[1:]',
    'text = Path(log).read_text()',
    `result = dict(code=int(code), releaseHash=digest, stdout=${JSON.stringify(UPDATE_INSTALLING)} if ${JSON.stringify(UPDATE_INSTALLING)} in text else "", output=text.strip().split("\\n")[-1][-300:])`,
    'temporary = path + ".tmp"',
    'fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
    'with os.fdopen(fd, "w") as file: json.dump(result, file)',
    'os.replace(temporary, path)',
    'shutil.rmtree(Path(log).parent)',
    'PY',
    'exit "$code"',
  ].join('\n')
  const started = spawnSync(
    'systemd-run',
    [
      '--user',
      '--no-ask-password',
      '--collect',
      '--quiet',
      '--property=Type=exec',
      'bash',
      '-c',
      report,
    ],
    { encoding: 'utf8' },
  )
  if (started.status !== 0)
    return { code: 1, stdout: '', output: 'Could not start the signed update' }
  return { code: 0, stdout: 'Signed update accepted', output: '' }
}

/** Only a pinned full peer may send a signed payload matching its running bundle. */
export async function pushRelease(
  release: string | null,
  target: UpdateTarget,
  ports: Pick<HubPorts, 'isInstanceName'> = tetherHubPorts,
): Promise<RunResult> {
  const fail = (output: string): RunResult => ({ code: null, stdout: '', output })
  if (!release) return fail('this Tether does not run from an installed release')
  if (!target.instance || !ports.isInstanceName(target.instance))
    return fail('The host named no usable instance')
  let installing = false
  try {
    const settings = readSettings(process.env, '')
    const pins = settings ? readPins(settings.allowlist) : []
    if (
      !settings ||
      pins.find((pin) => pin.name === settings.machine)?.role !== 'full' ||
      !pins.some((pin) => pin.name === target.entry.name)
    )
      return fail('Only a full peer may update an approved machine')
    const input = readFileSync(join(release, SIGNED_RELEASE), 'utf8')
    const signed = verifyRelease(input, readUpdateKeys(settings.updatePins || DEFAULT_UPDATE_PINS))
    if (signed.bundleHash !== bundleHash(release) || signed.releaseHash !== releaseHash(release))
      return fail('Signed release is stale; nothing sent')
    const id = randomUUID()
    const start = await requestExec(
      target.control,
      [
        'sh',
        '-c',
        'exec "$HOME/.local/lib/tether/bin/tether" fleet receive-update "$@"',
        'aico-update',
        target.instance,
        target.entry.socket,
        target.entry.stateDir || '',
        id,
      ],
      Buffer.from(input),
    )
    if (start.code !== 0 && start.code !== 255) return start
    if (start.stdout.includes('Already installed')) return start
    installing = true
    const deadline = Date.now() + UPDATE_RUN_MS
    while (Date.now() < deadline) {
      const answer = await requestExec(
        target.control,
        [
          'sh',
          '-c',
          'exec "$HOME/.local/lib/tether/bin/tether" fleet update-result "$@"',
          'aico-update',
          id,
          signed.releaseHash,
        ],
        Buffer.alloc(0),
      )
      if (answer.code === 0) {
        const result = JSON.parse(answer.stdout) as RunResult
        if (result.code !== null) return result
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return {
      code: 1,
      stdout: UPDATE_INSTALLING,
      output: 'The signed update did not report its result before the update deadline',
    }
  } catch (error) {
    if (installing)
      return {
        code: 1,
        stdout: UPDATE_INSTALLING,
        output: 'Could not read the signed update result',
      }
    // Say why (no signed-update.json, a bad signature, unreadable pins), or the
    // log repeats one opaque line on every link-up.
    return fail(`No usable signed release (${(error as Error).message}); nothing sent`)
  }
}
