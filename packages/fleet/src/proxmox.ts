// Aico's own Proxmox control: the Proxmox HTTP API with a scoped token held in Aico Logins,
// HTTPS pinned to the PVE root CA. Proxmox enforces what each machine's token may do; there is
// no shell, `pvesh` or root ssh on this path. `aico vm`, the Projects page, peer power and
// placement all share this one client.
import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import data from '../data/proxmox.json' with { type: 'json' }
import { loginMachine } from './logins'
import { loginCaller } from './logins-cli'
import { LoginClient } from './logins-client'

export const proxmoxConfig = data

/** A failed Proxmox call; `status` is the HTTP status when Proxmox answered. */
export class PveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface PveCredential {
  tokenId: string
  tokenSecret: string
}
export type PveRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>

/** Seams for tests; the defaults read Logins, the pinned CA and node:https. */
export interface PveTransport {
  credential?: () => Promise<PveCredential>
  ca?: () => Buffer
  request?: typeof request
  /** Socket timeout of one request; default `requestSeconds`. */
  timeoutMs?: number
}

/** The login holding this machine's token: its own when the data names one, else the shared one. */
export function pveLoginName(machine = loginMachine()): string {
  return (data.machineLogins as Record<string, string>)[machine] ?? data.login
}

const caFile = () =>
  data.caBundle.startsWith('~/') ? join(homedir(), data.caBundle.slice(2)) : data.caBundle

/**
 * One request function. The token is read from Logins once and reused for
 * `credentialMinutes`, or until Proxmox answers 401 (a rotated token), which refetches and retries once.
 */
export function pveRequest(
  env: NodeJS.ProcessEnv = process.env,
  transport: PveTransport = {},
): PveRequest {
  let cached: { at: number; value: Promise<PveCredential> } | null = null
  const fetchCredential = async () =>
    transport.credential
      ? await transport.credential()
      : (JSON.parse(
          (
            await new LoginClient(env).value(pveLoginName(), loginCaller(env), 'VM operation')
          ).toString(),
        ) as PveCredential)
  const credential = async (): Promise<PveCredential> => {
    if (!cached || Date.now() - cached.at > data.credentialMinutes * 60_000)
      cached = { at: Date.now(), value: fetchCredential() }
    try {
      const value = await cached.value
      if (!value.tokenId || !value.tokenSecret)
        throw new PveError('Scoped Proxmox login is incomplete')
      return value
    } catch (error) {
      cached = null
      throw error instanceof PveError
        ? error
        : new PveError('Scoped Proxmox login is unavailable in Aico Logins')
    }
  }
  const send = (
    token: PveCredential,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    const url = new URL(`/api2/json${path}`, data.apiUrl)
    const payload = body
      ? new URLSearchParams(
          Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]),
        ).toString()
      : undefined
    return new Promise<unknown>((accept, reject) => {
      const req = (transport.request ?? request)(
        url,
        {
          method,
          ca: transport.ca ? transport.ca() : readFileSync(caFile()),
          headers: {
            Authorization: `PVEAPIToken=${token.tokenId}=${token.tokenSecret}`,
            ...(payload
              ? {
                  'content-type': 'application/x-www-form-urlencoded',
                  'content-length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', () => reject(new PveError('Proxmox response failed')))
          res.on('end', () => {
            if (!res.statusCode || res.statusCode >= 400)
              return reject(
                new PveError(
                  `Proxmox API refused the operation (HTTP ${res.statusCode ?? 'unknown'})`,
                  res.statusCode,
                ),
              )
            try {
              accept((JSON.parse(Buffer.concat(chunks).toString()) as { data: unknown }).data)
            } catch {
              reject(new PveError('Proxmox returned invalid JSON'))
            }
          })
        },
      )
      req.setTimeout(transport.timeoutMs ?? data.requestSeconds * 1000, () =>
        req.destroy(new Error('timeout')),
      )
      req.on('error', () => reject(new PveError('Proxmox API connection failed')))
      req.end(payload)
    })
  }
  return async (method, path, body) => {
    try {
      return await send(await credential(), method, path, body)
    } catch (error) {
      if (!(error instanceof PveError) || error.status !== 401) throw error
      cached = null
      return await send(await credential(), method, path, body)
    }
  }
}

export const isUpid = (task: unknown): task is string =>
  typeof task === 'string' && task.startsWith('UPID:')

/** Wait for a PVE task (UPID) to stop; a non-OK exit status is a PveError. */
export async function waitTask(
  call: PveRequest,
  node: string,
  task: string,
  timeoutMs = data.taskSeconds * 1000,
): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const status = (await call(
      'GET',
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(task)}/status`,
    )) as { status?: string; exitstatus?: string }
    if (status.status === 'stopped') {
      if (status.exitstatus !== 'OK')
        throw new PveError(`Proxmox task failed: ${status.exitstatus ?? 'unknown'}`)
      return
    }
    if (Date.now() >= until) throw new PveError(`Proxmox task did not finish: ${task}`)
    await delay(1000)
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const node = (name: string) => {
  if (!NAME.test(name)) throw new PveError('Bad Proxmox node name')
  return encodeURIComponent(name)
}

/** The node's status document (memory and the rest), for placement room. */
export async function nodeStatus(call: PveRequest, name: string): Promise<unknown> {
  return await call('GET', `/nodes/${node(name)}/status`)
}

/** One storage's status on a node (`avail` bytes free). */
export async function storageStatus(
  call: PveRequest,
  name: string,
  storage: string,
): Promise<unknown> {
  if (!NAME.test(storage)) throw new PveError('Bad Proxmox storage name')
  return await call('GET', `/nodes/${node(name)}/storage/${encodeURIComponent(storage)}/status`)
}

/** One VM's current status (status, maxmem, cpus). */
export async function vmStatus(call: PveRequest, name: string, vmid: number): Promise<unknown> {
  if (!Number.isSafeInteger(vmid) || vmid < 100) throw new PveError('Bad Proxmox VM id')
  return await call('GET', `/nodes/${node(name)}/qemu/${vmid}/status/current`)
}

/** A guest's configuration as Proxmox stores it. */
export async function guestConfig(
  call: PveRequest,
  guest: { vmid: number; type: string; node: string },
): Promise<Record<string, unknown>> {
  if (guest.type !== 'qemu' && guest.type !== 'lxc') throw new PveError('Bad Proxmox guest type')
  const config = await call('GET', `/nodes/${node(guest.node)}/${guest.type}/${guest.vmid}/config`)
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new PveError('Proxmox returned a guest config that is not an object')
  return config as Record<string, unknown>
}

/** Set a guest's start-at-boot. */
export async function setOnboot(
  call: PveRequest,
  guest: { vmid: number; type: string; node: string },
  on: boolean,
): Promise<void> {
  if (guest.type !== 'qemu' && guest.type !== 'lxc') throw new PveError('Bad Proxmox guest type')
  await call('PUT', `/nodes/${node(guest.node)}/${guest.type}/${guest.vmid}/config`, {
    onboot: on ? 1 : 0,
  })
}
