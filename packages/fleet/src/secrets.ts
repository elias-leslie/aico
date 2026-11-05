// Credentials travel only on an approved full peer's exec channel, never argv or logs.
import { lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loginCaller } from './logins-cli'
import { pushLoginGrants } from './logins-delivery'
import { type FleetSettings, fleetFile } from './settings'
import { readPins } from './trust'

export { parseToolSecrets } from './secret-files'

import { parseToolSecrets } from './secret-files'

export type { ToolSecret } from './secret-files'

import type { ToolSecret } from './secret-files'

export { privateFile, secretsDir, toolLoginsFile, writePrivate } from './secret-files'

import { LoginStore } from './logins'
import { privateFile, secretsDir, toolLoginsFile, writePrivate } from './secret-files'

const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
export function loadToolSecrets(env = process.env): ToolSecret[] {
  return parseToolSecrets(
    new LoginStore(env).list().flatMap((entry) => (entry.tool ? [entry.tool] : [])),
  )
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
  new LoginStore(env).syncTools(combined)
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
  const remaining = entries.filter((entry) => entry.tool !== tool)
  new LoginStore(env).syncTools(remaining)
}
export function toolEnvironment(tool: string, env = process.env): NodeJS.ProcessEnv {
  const next = { ...env }
  const store = new LoginStore(env)
  for (const entry of loadToolSecrets(env).filter((entry) => entry.tool === tool && entry.envVar))
    next[entry.envVar as string] = store.toolValue(entry.file, loginCaller(env)).toString().trim()
  return next
}
export async function pushToolLogins(
  settings: FleetSettings,
  name: string,
  tool?: string,
  env = process.env,
): Promise<string[]> {
  if (tool && !loadToolSecrets(env).some((entry) => entry.tool === tool))
    throw new Error('No approved stored login for this tool')
  return pushLoginGrants(settings, name, env)
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
  const store = new LoginStore(env)
  for (const entry of store.list().filter((entry) => entry.tool?.tool === tool))
    store.grant(entry.name, 'machine', name, granted, {
      owner: true,
      role: 'owner',
      machine: settings.machine,
    })
  writePrivate(fleetFile(env), JSON.stringify(settings, null, 2))
  return settings
}
