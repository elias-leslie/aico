// No test deletes or moves anything outside a temp folder, whatever config or clock it runs with.
// Added after a test ran the real scratch sweep on the real disk.
import childProcess from 'node:child_process'
import fs, { existsSync, realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const ROOTS = [tmpdir(), '/tmp', '/var/tmp', '/dev/shm'].map(real)
const inTemp = (path: string) => ROOTS.some((root) => path === root || path.startsWith(`${root}/`))

function refuseOutsideTemp(target: unknown, what: string): void {
  const raw =
    target instanceof URL
      ? fileURLToPath(target)
      : Buffer.isBuffer(target)
        ? target.toString()
        : target
  if (typeof raw !== 'string') return
  const path = resolve(raw)
  // The parent resolves links; the entry itself may be a link being removed, or already gone.
  const seen = resolve(real(dirname(path)), path.slice(dirname(path).length + 1))
  if (inTemp(seen)) return
  throw new Error(`A test tried ${what} on ${seen}, outside a temp folder.`)
}

const guarded = (host: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const original = host[name] as (...args: unknown[]) => unknown
    host[name] = (...args: unknown[]) => {
      refuseOutsideTemp(args[0], name)
      return original.apply(host, args)
    }
  }
}
guarded(fs as unknown as Record<string, unknown>, [
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'renameSync',
  'rm',
  'rmdir',
  'unlink',
  'rename',
])
guarded(fs.promises as unknown as Record<string, unknown>, ['rm', 'rmdir', 'unlink', 'rename'])

// A plain `tmux` inside a session talks to that session's server through $TMUX: tests never inherit it.
delete process.env.TMUX
delete process.env.TMUX_PANE

// A test never runs the real machine-changing programs; a stub that sits in a temp folder is fine.
const REAL_NEVER = new Set('sudo systemctl ssh scp rsync qm pct reboot shutdown poweroff podman docker pkill killall btrfs restic rclone'.split(' '))
const SHELLS = new Set(['sh', 'bash', 'dash'])
const SHELL_NEVER = new Set(['pkill', 'killall', 'reboot', 'shutdown', 'poweroff'])
function refuseRealProgram(name: string, file: string, argv: unknown[], opts: childProcess.SpawnOptions) {
  const program = basename(file)
  if (!REAL_NEVER.has(program) && program !== 'rm' && program !== 'tmux') return
  const dirs = file.includes('/') ? [''] : (opts.env?.PATH ?? process.env.PATH ?? '').split(':')
  const found = dirs.map((dir) => join(dir, file)).find((path) => existsSync(path))
  if (!found || inTemp(real(resolve(found)))) return
  const words = argv.map(String)
  if (program === 'rm') {
    for (const word of words.filter((w) => !w.startsWith('-')))
      refuseOutsideTemp(resolve(String(opts.cwd ?? '.'), word), 'rm')
  } else if (program === 'tmux') {
    const at = (flag: string) => (words.includes(flag) ? words[words.indexOf(flag) + 1] : undefined)
    if (words.includes('-V') || inTemp(real(resolve(at('-S') ?? '/'))) || (at('-L') && at('-L') !== 'default')) return
    throw new Error(`A test ran ${name} tmux without a socket of its own; that reaches the owner's sessions.`)
  } else throw new Error(`A test ran the real ${program} through ${name}; stub it in a temp folder.`)
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'] as const) {
  const original = childProcess[name] as (...args: unknown[]) => unknown
  const check = (...args: unknown[]) => {
    const shell = name.startsWith('exec') && !name.startsWith('execFile')
    const [first, ...rest] = shell ? String(args[0]).trim().split(/\s+/) : [String(args[0])]
    const stop = rest.findIndex((word) => /^(&&|\|\||;|\||&)$/.test(word))
    const argv = shell ? (stop < 0 ? rest : rest.slice(0, stop)) : Array.isArray(args[1]) ? args[1] : []
    const opts = (args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a)) ??
      {}) as childProcess.SpawnOptions
    refuseRealProgram(name, first as string, argv, opts)
    // The rest of a command line a shell will read, as conftest.py does. Only the programs with
    // nothing safe to run: a contained-sandbox test may name systemctl or tmux in its script.
    const script = shell
      ? rest.join(' ')
      : opts.shell
        ? [first, ...argv].join(' ')
        : SHELLS.has(basename(first as string)) && argv.includes('-c')
          ? String(argv.at(-1))
          : ''
    const words = script.split(/[\s;&|()'"]+/).filter(Boolean)
    words.forEach((word, i) => {
      if (SHELL_NEVER.has(basename(word))) refuseRealProgram(name, word, words.slice(i + 1), opts)
    })
  }
  const wrapped = (...args: unknown[]) => (check(...args), original.apply(childProcess, args))
  const kept = Object.getOwnPropertyDescriptors(original)
  delete kept[promisify.custom as unknown as string]
  Object.defineProperties(wrapped, kept)
  const custom = (original as unknown as Record<symbol, (...args: unknown[]) => unknown>)[promisify.custom]
  if (custom)
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]) => (check(...args), custom(...args)),
    })
  ;(childProcess as unknown as Record<string, unknown>)[name] = wrapped
}
syncBuiltinESMExports()
