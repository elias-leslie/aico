// The real process and HTTP calls behind vision-extract. No time limit on
// either: a call ends when the process exits or the connection errors.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { VisionRunners } from './index'

/** agy prints the whole answer (and the schema back) once; allow plenty. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export const realRunners: VisionRunners = {
  exec: (argv, options) =>
    new Promise((resolve, reject) => {
      const [program, ...args] = argv
      const child = execFile(
        program as string,
        args,
        { cwd: options.cwd, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          const code = error ? (error as NodeJS.ErrnoException).code : 0
          if (error && typeof code !== 'number') return reject(error)
          resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr })
        },
      )
      child.stdin?.end()
    }),
  post: async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  },
  read: (path) => readFile(path),
}
