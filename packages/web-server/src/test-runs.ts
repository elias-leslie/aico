// Which runs are smoke, scratch or junk rather than the owner's work. One rule on the
// server so Recent, the live list and the morning digest agree on what to leave out.

import { basename } from 'node:path'

/** Name parts (split on - _ . and digits) that mark a throwaway run. Tune here. */
export const TEST_RUN_TOKENS: readonly string[] = [
  'smoke',
  'tmp',
  'temp',
  'scratch',
  'try',
  'live',
  'probe',
  'trial',
  'test',
  'tmpdir',
]

/** Folders whose contents are throwaway by definition. */
const TEST_RUN_ROOTS: readonly string[] = ['/tmp', '/var/tmp', '/srv/scratch']

const tokensOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[-_.\d]+/)
    .filter(Boolean)

const marked = (name: string | null | undefined): boolean =>
  !!name && tokensOf(name).some((token) => TEST_RUN_TOKENS.includes(token))

/** True for a smoke, tmp or junk run: its folder is throwaway, or its project or folder name says so. */
export function isTestRun({
  project,
  cwd,
}: {
  project?: string | null
  cwd?: string | null
}): boolean {
  if (cwd && TEST_RUN_ROOTS.some((root) => cwd === root || cwd.startsWith(`${root}/`))) return true
  return marked(project) || marked(cwd ? basename(cwd.replace(/\/+$/, '')) : null)
}
