// No test deletes or moves anything outside a temp folder, whatever config or clock it runs with.
// Added after a test ran the real scratch sweep on the real disk.
import fs, { realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const ROOTS = [tmpdir(), '/tmp', '/var/tmp', '/dev/shm'].map(real)

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
  if (ROOTS.some((root) => seen === root || seen.startsWith(`${root}/`))) return
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
syncBuiltinESMExports()
