// What a deploy installs beyond its release: the ops bundle `aico deploy` itself runs (a link to a
// release), the host-steward root sources (signed, through the root installer) and aico-hook. Each has
// a wanted check, an install, and leaves a newer commit's install alone unless this is a rollback.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { signDetached } from '@aico/fleet/releases'
import { secretsDir } from '@aico/fleet/secrets'
import {
  type DeployConfig,
  type DeployDeps,
  opsBundle,
  Refusal,
  runningSha,
  touches,
} from './deploy-model'
import { expandHome, tail } from './sh'

export function restoreOps(previous: string | null | undefined, deps: DeployDeps) {
  if (previous === undefined) return
  if (previous === null) rmSync(deps.opsLink, { force: true })
  else installOpsBundle(deps, previous)
}

/** The release commit whose ops bundle `aico deploy` runs, or null before the first install. */
export function installedOpsSha(deps: DeployDeps): string | null {
  try {
    const target = realpathSync(deps.opsLink)
    return runningSha(`WorkingDirectory=${target}\n`, realpathSync(deps.releasesDir))
  } catch {
    return null
  }
}

/**
 * Whether this deploy installs its ops bundle: none is installed, or the commit changed its `sources`
 * since the installed one (unknown: install). An installed commit this one does not contain is left
 * alone unless this is a rollback.
 */
export function opsInstallWanted(
  root: string,
  sha: string,
  sources: string[],
  rollback: boolean,
  deps: DeployDeps,
): boolean {
  const installed = installedOpsSha(deps)
  if (!installed) return true
  if (installed === sha) return false
  const contained =
    rollback ||
    deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', installed, sha]).code === 0
  if (!contained) return false
  const diff = deps.run('git', ['-C', root, 'diff', '--name-only', installed, sha])
  return diff.code !== 0 || touches(diff.out.split('\n').filter(Boolean), sources)
}

/** Point the link at this release's ops bundle (atomically: a new link renamed over the old). */
export function installOpsBundle(deps: DeployDeps, release: string) {
  if (!existsSync(opsBundle(release)))
    throw new Refusal(`The release has no ops bundle at ${opsBundle(release)}`)
  if (
    existsSync(join(release, 'packages/cli/package.json')) &&
    !existsSync(join(release, 'packages/cli/dist/aico-cli.mjs'))
  )
    throw new Refusal('The release has no CLI bundle')
  // st service and st skills run from this release's own Python env; set up here, the first call
  // after a deploy would wait in the shared heavy lane (behind a long build) just to install it.
  const tools = join(release, 'native/service-tools')
  if (existsSync(join(tools, 'uv.lock')) && !existsSync(join(tools, '.venv/bin/python'))) {
    deps.out('[deploy] preparing st service tools')
    const sync = deps.run(
      'nice',
      ['-n', '10', 'uv', 'sync', '--quiet', '--locked', '--no-dev', '--directory', tools],
      { cwd: tools, env: deps.env },
    )
    if (sync.code !== 0)
      deps.out(`[deploy] st service tools set up on first use instead: ${tail(sync, 2)}`)
  }
  const temporary = `${deps.opsLink}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  mkdirSync(join(deps.opsLink, '..'), { recursive: true })
  symlinkSync(release, temporary)
  renameSync(temporary, deps.opsLink)
  deps.out(`[deploy] aico deploy now runs from ${release.split('/').at(-1)?.slice(0, 12)}`)
}

// ---- the root install (host-steward) ---------------------------------------------------------

/** The commit the installed root sources came from (the signed installer's receipt), or null. */
export function installedRootSha(receipt: string): string | null {
  try {
    const sha = (JSON.parse(readFileSync(receipt, 'utf8')) as { sha?: unknown }).sha
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Whether this deploy installs the root sources: the machine has the signed installer, the commit
 * has the sources, and they changed since the installed commit (unknown: install). An installed
 * commit this one does not contain is left alone, as units are, unless this is a rollback.
 */
export function rootInstallWanted(
  root: string,
  sha: string,
  cfg: DeployConfig,
  rollback: boolean,
  deps: DeployDeps,
): boolean {
  const spec = cfg.rootInstall
  if (!spec?.sources?.length) return false
  const listed = deps.run('git', ['-C', root, 'ls-tree', '--name-only', sha, '--', ...spec.sources])
  if (listed.code !== 0 || !listed.out.trim()) return false
  if (!existsSync(spec.installer)) {
    deps.out(
      `[deploy] host-steward root install skipped: this machine has no signed installer at ${spec.installer}`,
    )
    return false
  }
  const installed = installedRootSha(spec.receipt)
  if (!installed) {
    deps.out('[deploy] host-steward root install: the installed commit is unknown; installing')
    return true
  }
  if (installed === sha) return false
  const git = (...args: string[]) => deps.run('git', ['-C', root, ...args])
  if (!rollback && git('merge-base', '--is-ancestor', installed, sha).code !== 0) {
    if (git('merge-base', '--is-ancestor', sha, installed).code === 0)
      deps.out(
        `[deploy] host-steward root install skipped: it runs ${installed.slice(0, 12)}, which contains ${sha.slice(0, 12)}`,
      )
    else
      deps.out(
        `[deploy] host-steward root install skipped: it runs ${installed.slice(0, 12)}, which ${sha.slice(0, 12)} does not contain; deploy a newer commit or pass --rollback`,
      )
    return false
  }
  const diff = git('diff', '--name-only', installed, sha, '--', ...spec.sources)
  if (diff.code === 0 && !diff.out.trim()) {
    deps.out(
      `[deploy] host-steward root install skipped: unchanged since ${installed.slice(0, 12)}`,
    )
    return false
  }
  return true
}

/**
 * Install the commit's root sources through the signed-update path: a git archive of them, signed
 * with the update key, handed to the installed `install-signed.py` as root, which verifies it
 * against the pinned public key before running anything from it. Null on success, else the problem.
 */
export function installRootSources(
  root: string,
  sha: string,
  cfg: DeployConfig,
  deps: DeployDeps,
): string | null {
  const spec = cfg.rootInstall
  deps.out(`[deploy] installing the host-steward root sources from ${sha.slice(0, 12)}`)
  const declared = deps.run(
    'host-steward',
    [
      'declare',
      '--host',
      hostname(),
      '--what',
      spec.declareWhat,
      '--hours',
      '1',
      '--reason',
      `aico deploy installs host-steward root services and timers from ${sha.slice(0, 12)}`,
    ],
    { env: deps.env },
  )
  if (declared.code !== 0)
    deps.err(
      `[deploy] WARNING could not declare the host change to the host check (${tail(declared, 1)}); installing anyway`,
    )
  const dir = mkdtempSync(join(tmpdir(), 'aico-root-install-'))
  try {
    const archive = join(dir, 'update.tar')
    const signature = join(dir, 'update.sig')
    const made = deps.run('git', [
      '-C',
      root,
      'archive',
      '--format=tar',
      '-o',
      archive,
      sha,
      '--',
      ...spec.sources,
    ])
    if (made.code !== 0) return `git archive failed: ${tail(made, 1)}`
    try {
      writeFileSync(
        signature,
        signDetached(readFileSync(archive), join(secretsDir(deps.env), spec.signingKey)),
      )
    } catch (error) {
      return `signing failed: ${(error as Error).message}`
    }
    const result = deps.run('sudo', ['-n', spec.installer, archive, signature], { env: deps.env })
    if (result.code !== 0) return tail(result, 2) || `the installer exited ${result.code}`
    const recorded = installedRootSha(spec.receipt)
    deps.out(
      recorded === sha
        ? `[deploy] host-steward root sources installed from ${sha.slice(0, 12)}`
        : `[deploy] host-steward root sources installed; the installer recorded no commit (an older installer), so the next deploy installs again`,
    )
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The commit's aico-hook tree id when the installed hook (the `current` link install.sh keeps) is
 * another build; null when the commit does not declare the hook install itself (an older
 * install.sh cannot run from an archive), the hook already matches, or the installed build is a
 * newer commit's (left alone unless this is a rollback, as units are).
 */
export function hookInstallWanted(
  root: string,
  sha: string,
  cfg: DeployConfig,
  rollback: boolean,
  deps: DeployDeps,
): string | null {
  const spec = cfg.hookInstall
  if (!spec?.source) return null
  const own = deps.run('git', ['-C', root, 'show', `${sha}:packages/ops/data/ops.json`])
  try {
    if (own.code !== 0 || !JSON.parse(own.out).deploy?.hookInstall) return null
  } catch {
    return null
  }
  const git = (...args: string[]) => deps.run('git', ['-C', root, ...args])
  const tree = git('rev-parse', '--short=12', `${sha}:${spec.source}`).out.trim()
  if (!tree) return null
  let current = ''
  try {
    current = basename(readlinkSync(join(expandHome(spec.dir), 'current')))
  } catch {}
  if (current === tree) return null
  if (!rollback && current) {
    const newer = git('rev-list', `${sha}..HEAD`, '--', spec.source).out.split('\n').filter(Boolean)
    if (
      newer.some(
        (commit) =>
          git('rev-parse', '--short=12', `${commit}:${spec.source}`).out.trim() === current,
      )
    ) {
      deps.out(`[deploy] aico-hook install skipped: it runs ${current}, a newer commit's build`)
      return null
    }
  }
  return tree
}

/** Build and install the commit's aico-hook with its own install.sh. Null on success, else the problem. */
export function installHook(
  root: string,
  sha: string,
  tree: string,
  cfg: DeployConfig,
  deps: DeployDeps,
): string | null {
  const spec = cfg.hookInstall
  deps.out(`[deploy] installing aico-hook ${tree} from ${sha.slice(0, 12)}`)
  const dir = mkdtempSync(join(tmpdir(), 'aico-hook-install-'))
  try {
    const archive = join(dir, 'hook.tar')
    const made = deps.run('git', [
      '-C',
      root,
      'archive',
      '--format=tar',
      '-o',
      archive,
      sha,
      '--',
      spec.source,
    ])
    if (made.code !== 0) return `git archive failed: ${tail(made, 1)}`
    const unpacked = deps.run('tar', ['-xf', archive, '-C', dir])
    if (unpacked.code !== 0) return `tar failed: ${tail(unpacked, 1)}`
    const result = deps.run('bash', [join(dir, spec.source, 'install.sh')], {
      env: { ...deps.env, AICO_HOOK_REL: tree, AICO_HOOK_BASE: expandHome(spec.dir) },
    })
    if (result.code !== 0) return tail(result, 2) || `install.sh exited ${result.code}`
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
