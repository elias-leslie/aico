// A small file that must survive a power cut whole: written to a temp file, on disk before it
// replaces the old one, and the folder synced so the replacement itself sticks. A plain
// write-then-rename can leave an empty file after a cut.

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
