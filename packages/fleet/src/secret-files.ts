import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import staticLogins from './static-logins.json' with { type: 'json' }
export function secretsDir(env = process.env): string {
  return join(
    env.AICO_DATA_DIR ||
      join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'aico'),
    'secrets',
  )
}
export function toolLoginsFile(env = process.env): string {
  return join(
    env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'),
    'aico/tool-logins.json',
  )
}
export function privateFile(path: string): Buffer {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error('Secret file must be owner-only with mode 0600')
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
      throw new Error('Secret file must be owner-only with mode 0600')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function writePrivate(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const dir = lstatSync(dirname(path))
  if (!dir.isDirectory() || dir.uid !== process.getuid?.())
    throw new Error('Login destination folder must belong to this user')
  const temp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fd, value)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

export interface ToolSecret {
  tool: string
  name: string
  file: string
  envVar?: string
  authFile?: string
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
export function parseToolSecrets(value: unknown): ToolSecret[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid tool login map')
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid tool login map')
    const { tool, name, file, envVar, authFile } = item as Record<string, unknown>
    const allowed = staticLogins.find((entry) => entry.tool === tool && entry.name === name)
    if (
      typeof tool !== 'string' ||
      !NAME.test(tool) ||
      typeof name !== 'string' ||
      !NAME.test(name) ||
      typeof file !== 'string' ||
      !NAME.test(file) ||
      !allowed ||
      allowed.envVar !== envVar ||
      allowed.authFile !== authFile ||
      !!envVar === !!authFile ||
      (envVar !== undefined &&
        (typeof envVar !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(envVar))) ||
      (authFile !== undefined &&
        (typeof authFile !== 'string' ||
          !/^\.[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(authFile)))
    )
      throw new Error('Invalid tool login map')
    const id = `${tool}/${name}`
    if (seen.has(id)) throw new Error('Duplicate tool login')
    seen.add(id)
    return {
      tool,
      name,
      file,
      ...(envVar ? { envVar: envVar as string } : {}),
      ...(authFile ? { authFile: authFile as string } : {}),
    }
  })
}
