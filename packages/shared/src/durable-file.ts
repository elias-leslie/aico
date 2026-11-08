// A small file that must survive a power cut whole: written to a temp file, on disk before it
// replaces the old one, and the folder synced so the replacement itself sticks. A plain
// write-then-rename can leave an empty file after a cut.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Serialize a file's read-modify-write across processes. The sidecar lock is never renamed or
 * removed: flock holds its inode, while the data file may be replaced durably. Closing the pipe
 * (also on a caller crash) ends the holder and releases the kernel lock, with no stale pid file.
 */
export async function withFileLock<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const child = spawn(
    'flock',
    [
      '-x',
      `${path}.lock`,
      process.execPath,
      '-e',
      'process.stdout.write("locked\\n"); process.stdin.resume()',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  child.stdin.on('error', () => {})
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`File lock exited ${code}`)),
    )
  })
  // A failed holder must not produce an unhandled rejection while the caller is still working.
  void ended.catch(() => {})
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.stdout.once('data', () => resolve())),
      ended.then(() => {
        throw new Error('File lock ended before it was acquired')
      }),
    ])
    return await fn()
  } finally {
    child.stdin.end()
    await ended
  }
}

/** Make a rename or new file in this folder stick. The write is already done, so a folder that can't be synced isn't an error. */
export function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {}
}

export function writeFileDurable(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const fd = openSync(temporary, 'wx', options.mode ?? 0o666)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  syncDir(dirname(path))
}
