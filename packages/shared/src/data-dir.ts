import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Aico's data folder on this machine: `AICO_DATA_DIR`, else `aico` under the XDG state folder
 * (`~/.local/state`). The Status outbox, job runs, secrets and Aico's own databases live here,
 * so a writer and the job that drains what it leaves must agree on it. */
export function aicoDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.AICO_DATA_DIR?.trim() ||
      join(env.XDG_STATE_HOME?.trim() || join(env.HOME || homedir(), '.local', 'state'), 'aico'),
  )
}
