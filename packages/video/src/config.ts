import { homedir } from 'node:os'
import { join } from 'node:path'
import data from '../data/video.json' with { type: 'json' }

export const config = data
export type Resolution = keyof typeof data.gemini.mediaResolution

/** Where one video's files live: AICO_VIDEO_DIR, else the first configured directory whose parent exists. */
export function cacheRoot(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const set = env[config.cache.envDir]?.trim()
  if (set) return set
  const home = env.HOME || homedir()
  const dirs = config.cache.dirs.map((dir) =>
    dir.startsWith('~/') ? join(home, dir.slice(2)) : dir,
  )
  // /srv/scratch is the shared host's cache area; elsewhere the user's cache directory serves.
  const chosen = dirs.find((dir) => exists(join(dir, '..', '..'))) ?? dirs[dirs.length - 1]
  return chosen
}
