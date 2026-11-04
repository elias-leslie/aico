// One way to run a command: captured output (or the caller's terminal) and an exit code, never a throw.

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RunResult {
  code: number
  out: string
  err: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  /** Stream to the caller's stdout/stderr instead of capturing. */
  inherit?: boolean
}

export type Runner = (cmd: string, args: string[], options?: RunOptions) => RunResult

export const run: Runner = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
    maxBuffer: 256 * 1024 * 1024,
  })
  return {
    code: result.status ?? (result.error ? 127 : 1),
    out: result.stdout ?? '',
    err: (result.stderr ?? '') || (result.error?.message ?? ''),
  }
}

/** `~/x` to an absolute path. */
export const expandHome = (path: string, home = homedir()) =>
  path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path

/** The last lines of a failed command's output, for the error message. */
export const tail = (result: RunResult, lines = 20) =>
  `${result.out}\n${result.err}`.trim().split('\n').slice(-lines).join('\n')
