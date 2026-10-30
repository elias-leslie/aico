// The owner notices Aico sends through Nightshift (notice contract v1): one
// small builder per notice, written to `nightshift push --json` on stdin.
// Failures are logged and never reach the caller; exit 2 is a contract
// refusal, a bug in the builder, and is logged loudly.

import { execFile } from 'node:child_process'

export const PUSH_TIMEOUT_MS = 10_000

export type NoticeAction = 'answer' | 'done'

/** The part of notice v1 Aico uses (Nightshift docs/notify-contract.schema.json). */
export interface Notice {
  v: 1
  source: 'aico'
  kind: 'question' | 'todo' | 'info'
  severity: 'info' | 'warning'
  title: string
  body: string
  key: string
  open?: string
  actions?: NoticeAction[]
  primary?: NoticeAction
  push: 'phone' | 'tray'
}

/** Runs a command, optionally feeding stdin; rejects on a non-zero exit, with `code` on the error. */
export type RunCommand = (argv: string[], timeoutMs: number, input?: string) => Promise<string>

export const runCommand: RunCommand = (argv, timeoutMs, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(argv[0], argv.slice(1), { timeout: timeoutMs }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    )
    if (input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })

export const PUSH_ARGV = ['nightshift', 'push', '--json']

/** Sends the notice; logs a failure, loudly for a contract refusal, and never throws. */
export async function sendNotice(run: RunCommand, notice: Notice): Promise<void> {
  try {
    await run(PUSH_ARGV, PUSH_TIMEOUT_MS, JSON.stringify(notice))
  } catch (error) {
    const err = error as Error & { code?: unknown }
    const refused = err.code === 2 ? ' (contract refusal, a bug)' : ''
    console.error(`[aico-web] notice failed key=${notice.key}${refused}: ${err.message}`)
  }
}

/** Tells Nightshift the condition behind `key` is over. */
export async function resolveNotice(run: RunCommand, key: string, text: string): Promise<void> {
  try {
    await run(['nightshift', 'resolve', key, '--text', text], PUSH_TIMEOUT_MS)
  } catch (error) {
    console.warn(`[aico-web] notice resolve failed key=${key}: ${(error as Error).message}`)
  }
}
