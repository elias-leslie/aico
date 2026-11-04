// Credentials travel only on an approved full peer's exec channel, never argv or logs.
import {
  closeSync,
  constants,
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
import { requestExec } from './exec'
import { type FleetSettings, fleetFile } from './settings'
import staticLogins from './static-logins.json' with { type: 'json' }
import { readPins } from './trust'

export interface ToolSecret {
  tool: string
  name: string
  file: string
  envVar?: string
  authFile?: string
}
const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
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
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error('Secret file must be owner-only with mode 0600')
  return readFileSync(path)
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
export function loadToolSecrets(env = process.env): ToolSecret[] {
  try {
    return parseToolSecrets(JSON.parse(privateFile(toolLoginsFile(env)).toString()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not read the tool login map')
  }
}
export function receiveLogins(input: string, env = process.env): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch {
    throw new Error('Invalid tool login delivery')
  }
  const delivery = raw as { entries?: unknown; tools?: unknown }
  if (
    !delivery ||
    !Array.isArray(delivery.entries) ||
    !Array.isArray(delivery.tools) ||
    delivery.tools.some((tool) => typeof tool !== 'string' || !NAME.test(tool))
  )
    throw new Error('Invalid tool login delivery')
  const entries = parseToolSecrets(delivery.entries)
  if (entries.some((entry) => !(delivery.tools as string[]).includes(entry.tool)))
    throw new Error('Invalid tool login delivery')
  const values = delivery.entries.map((item: { value?: unknown }) => item.value)
  if (
    values.some((value) => typeof value !== 'string' || !value || Buffer.byteLength(value) > 65536)
  )
    throw new Error('Invalid tool login delivery')
  for (const tool of new Set(loadToolSecrets(env).map((entry) => entry.tool)))
    if (!delivery.tools.includes(tool)) forgetLogin(tool, env)
  mkdirSync(secretsDir(env), { recursive: true, mode: 0o700 })
  const folder = lstatSync(secretsDir(env))
  if (!folder.isDirectory() || folder.uid !== process.getuid?.() || folder.mode & 0o077)
    throw new Error('Secrets folder must be owner-only with mode 0700')
  const ids = new Set(entries.map((entry) => `${entry.tool}/${entry.name}`))
  const combined = [
    ...loadToolSecrets(env).filter((entry) => !ids.has(`${entry.tool}/${entry.name}`)),
    ...entries,
  ]
  // Record destinations first: even a partial delivery can always be revoked.
  writePrivate(toolLoginsFile(env), JSON.stringify(combined))
  entries.forEach((entry, i) => {
    const value = values[i] as string
    writePrivate(join(secretsDir(env), entry.file), value)
    if (entry.authFile) writePrivate(join(env.HOME || homedir(), entry.authFile), value)
  })
  return entries.map((entry) => entry.file)
}
export function forgetLogin(tool: string, env = process.env): void {
  const entries = loadToolSecrets(env)
  for (const entry of entries.filter((entry) => entry.tool === tool)) {
    for (const path of [
      join(secretsDir(env), entry.file),
      ...(entry.authFile ? [join(env.HOME || homedir(), entry.authFile)] : []),
    ]) {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  writePrivate(toolLoginsFile(env), JSON.stringify(entries.filter((entry) => entry.tool !== tool)))
}
export function toolEnvironment(tool: string, env = process.env): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const entry of loadToolSecrets(env).filter((entry) => entry.tool === tool && entry.envVar))
    next[entry.envVar as string] = privateFile(join(secretsDir(env), entry.file))
      .toString()
      .trim()
  return next
}
export async function pushToolLogins(
  settings: FleetSettings,
  name: string,
  tool?: string,
  env = process.env,
): Promise<string[]> {
  const pins = readPins(settings.allowlist)
  if (
    pins.find((pin) => pin.name === settings.machine)?.role !== 'full' ||
    !pins.some((pin) => pin.name === name)
  )
    throw new Error('Only a full peer may push logins to an approved machine')
  const peer = settings.peers.find((peer) => peer.name === name)
  if (!peer) throw new Error('Machine has no fleet endpoint')
  if (peer.tools === undefined) return []
  const entries = loadToolSecrets(env).filter((entry) => peer.tools?.includes(entry.tool))
  if (tool && !entries.some((entry) => entry.tool === tool))
    throw new Error('No approved stored login for this tool')
  const body = entries.map((entry) => ({
    ...entry,
    value: privateFile(join(secretsDir(env), entry.file)).toString(),
  }))
  const result = await requestExec(
    join(settings.peerRoot, name, 'exec.sock'),
    ['sh', '-c', 'exec "$HOME/.local/lib/tether/bin/tether" fleet receive-logins'],
    Buffer.from(JSON.stringify({ entries: body, tools: peer.tools })),
  )
  if (result.code !== 0) throw new Error('Peer refused the tool login delivery')
  return entries.map((entry) => entry.file)
}
export function setToolGrant(
  settings: FleetSettings,
  name: string,
  tool: string,
  granted: boolean,
  env = process.env,
): FleetSettings {
  const peer = settings.peers.find((peer) => peer.name === name)
  if (!peer || !readPins(settings.allowlist).some((pin) => pin.name === name))
    throw new Error('Machine is not on the allowlist')
  const tools = new Set(peer.tools || [])
  if (granted) tools.add(tool)
  else tools.delete(tool)
  peer.tools = [...tools]
  writePrivate(fleetFile(env), JSON.stringify(settings, null, 2))
  return settings
}
