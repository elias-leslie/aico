// Full extractions kept on this machine so `refocus` can give another view without the
// network. One 0600 JSON file per fetch, named by a 32-hex id.

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type Record_ = Record<string, unknown>

function cacheHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'))
}

const cacheDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.AICO_WEB_CACHE_DIR?.trim()
    ? resolve(env.AICO_WEB_CACHE_DIR.trim())
    : join(cacheHome(env), 'aico', 'web')

export function saveArtifact(
  payload: Record_,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): Record_ {
  const root = cacheDir(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const id = randomBytes(16).toString('hex')
  const path = join(root, `${id}.json`)
  const record = {
    ...payload,
    content,
    artifact_id: id,
    artifact_version: 1,
    full_content_chars: content.length,
    artifact_content_scope:
      payload.artifact_kind === 'raw_response' ? 'raw_response' : 'full_extracted_text',
  }
  writeFileSync(path, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  return { artifact_id: id, artifact_path: path, full_content_chars: content.length }
}

/** A stored extraction by id or absolute path; throws a plain reason when it can't be trusted. */
export function loadArtifact(reference: string, env: NodeJS.ProcessEnv = process.env): Record_ {
  const roots = [cacheDir(env)]
  let path: string
  if (/^[a-f0-9]{32}$/.test(reference)) {
    const name = `${reference}.json`
    path = join(roots.find((root) => existsSync(join(root, name))) ?? (roots[0] as string), name)
  } else {
    path = resolve(reference.replace(/^~(?=\/)/, homedir()))
    if (!reference.startsWith('/') && !reference.startsWith('~'))
      throw new Error('artifact must be an owner cache id or absolute owner cache path')
  }
  const inside = roots.some((root) => {
    try {
      return realpathSync(dirname(path)) === realpathSync(root)
    } catch {
      return false
    }
  })
  if (
    !inside ||
    !/^[a-f0-9]{32}\.json$/.test(path.split('/').pop() ?? '') ||
    (existsSync(path) && lstatSync(path).isSymbolicLink())
  )
    throw new Error('artifact path is outside the trusted owner cache')
  let record: Record_
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`artifact unavailable: ${(error as Error).message}`)
  }
  if (record?.artifact_version !== 1 || typeof record.content !== 'string')
    throw new Error('invalid owner web artifact')
  if (record.artifact_id !== (path.split('/').pop() as string).replace(/\.json$/, ''))
    throw new Error('artifact identity mismatch')
  return { ...record, artifact_path: path }
}
