// Whether a tool can run the model a create asks for, by asking the tool the
// way a pane would launch it (same command, PATH and environment), so a bad
// model is refused before a root starts instead of failing inside its pane.

import { execFile } from 'node:child_process'
import { effectiveTuiPath } from './launch'
import type { TuiSpec } from './spec'

const LIST_TIMEOUT_MS = 20_000

/** Provider/model pairs from a `provider  model  …` table, or null when the
 * output has no such header. */
export function parseModelTable(text: string): Set<string> | null {
  const rows = text.split('\n').map((line) => line.trim().split(/\s+/))
  const header = rows.findIndex(([provider, model]) => provider === 'provider' && model === 'model')
  if (header < 0) return null
  return new Set(
    rows
      .slice(header + 1)
      .flatMap(([provider, model]) => (provider && model ? [`${provider}/${model}`] : [])),
  )
}

/** True or false when the tool listed its models; null when it has no list
 * command or the list could not be read (the launch then goes ahead). */
export function listsModel(spec: TuiSpec, model: string): Promise<boolean | null> {
  const list = spec.modelSelection?.listModels
  const command = spec.command[0]
  if (!list || !command) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', 'exec "$@"', 'aico-list-models', command, ...list],
      {
        env: { ...process.env, ...(spec.env ?? {}), PATH: effectiveTuiPath(spec) },
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        const models = error ? null : parseModelTable(String(stdout))
        resolve(models && models.size > 0 ? models.has(model) : null)
      },
    )
  })
}
