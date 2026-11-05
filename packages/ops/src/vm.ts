// Proxmox VM operations use the existing scoped API token held in Aico Logins.
// Proxmox enforces its pool rights; no SummitFlow service is involved.

import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { loginCaller } from '@aico/fleet/logins-cli'
import { LoginClient } from '@aico/fleet/logins-client'
import ops from '../data/ops.json' with { type: 'json' }
import { Refusal } from './deploy'
import { type Runner, tail } from './sh'

export interface Guest {
  vmid: number
  name: string
  type: 'qemu' | 'lxc'
  status: string
  pool: string | null
  node: string
  maxmem: number
  maxdisk: number
}

/** One scoped Proxmox operation, or a Refusal. */
export type VmOp = (op: string, vmid?: string, args?: Record<string, unknown>) => Promise<unknown>

export interface VmCredential {
  tokenId: string
  tokenSecret: string
}
export type PveRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>

/** HTTPS is pinned to the existing PVE CA; Logins grants the existing scoped token at runtime. */
export interface PveTransport {
  credential?: () => Promise<VmCredential>
  ca?: () => Buffer
  request?: typeof request
}
export function pveRequest(
  env: NodeJS.ProcessEnv = process.env,
  transport: PveTransport = {},
): PveRequest {
  return async (method, path, body) => {
    const login = new LoginClient(env)
    let credential: VmCredential
    try {
      credential = transport.credential
        ? await transport.credential()
        : (JSON.parse(
            (await login.value(ops.vm.login, loginCaller(env), 'VM operation')).toString(),
          ) as VmCredential)
    } catch {
      throw new Refusal('Scoped Proxmox login is unavailable in Aico Logins')
    }
    if (!credential.tokenId || !credential.tokenSecret)
      throw new Refusal('Scoped Proxmox login is incomplete')
    const url = new URL(`/api2/json${path}`, ops.vm.apiUrl)
    const payload = body
      ? new URLSearchParams(
          Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]),
        ).toString()
      : undefined
    return new Promise((accept, reject) => {
      const req = (transport.request ?? request)(
        url,
        {
          method,
          ca: transport.ca ? transport.ca() : readFileSync(ops.vm.caBundle),
          headers: {
            Authorization: `PVEAPIToken=${credential.tokenId}=${credential.tokenSecret}`,
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
          res.on('error', () => reject(new Refusal('Proxmox response failed')))
          res.on('end', () => {
            if (!res.statusCode || res.statusCode >= 400)
              return reject(
                new Refusal(
                  `Proxmox API refused the operation (HTTP ${res.statusCode ?? 'unknown'})`,
                ),
              )
            try {
              accept((JSON.parse(Buffer.concat(chunks).toString()) as { data: unknown }).data)
            } catch {
              reject(new Refusal('Proxmox returned invalid JSON'))
            }
          })
        },
      )
      req.setTimeout(ops.vm.timeoutSeconds * 1000, () => req.destroy(new Error('timeout')))
      req.on('error', () => reject(new Refusal('Proxmox API connection failed')))
      req.end(payload)
    })
  }
}

/** A direct PVE API operation. Proxmox continues to enforce the scoped token's pool rights. */
export function routeOp(
  env: NodeJS.ProcessEnv = process.env,
  call: PveRequest = pveRequest(env),
): VmOp {
  return async (op, vmid, args = {}) => {
    const guests = guestRows(await call('GET', '/cluster/resources?type=vm'))
    if (op === 'list_vms') return guests
    const guest = guests.find((row) => String(row.vmid) === vmid)
    if (!guest) throw new Refusal(`No visible Proxmox guest ${vmid}`)
    const base = `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`
    if (op === 'status')
      return {
        ...((await call('GET', `${base}/status/current`)) as object),
        vmid: guest.vmid,
        name: guest.name,
      }
    let task: unknown
    if (op === 'start' || op === 'stop') task = await call('POST', `${base}/status/${op}`)
    else if (op === 'snapshot')
      task = await call('POST', `${base}/snapshot`, {
        snapname: args.name,
        description: args.description,
      })
    else throw new Refusal(`Unsupported Proxmox operation ${op}`, 2)
    if (typeof task === 'string' && task.startsWith('UPID:')) {
      const until = Date.now() + ops.vm.timeoutSeconds * 1000
      for (;;) {
        const status = (await call(
          'GET',
          `/nodes/${encodeURIComponent(guest.node)}/tasks/${encodeURIComponent(task)}/status`,
        )) as { status?: string; exitstatus?: string }
        if (status.status === 'stopped') {
          if (status.exitstatus !== 'OK')
            throw new Refusal(`Proxmox task failed: ${status.exitstatus ?? 'unknown'}`)
          break
        }
        if (Date.now() >= until) throw new Refusal(`Proxmox task did not finish: ${task}`)
        await delay(1000)
      }
    }
    return null
  }
}

export function guestRows(rows: unknown): Guest[] {
  return ((Array.isArray(rows) ? rows : []) as Record<string, unknown>[])
    .map((row) => ({
      vmid: Number(row.vmid),
      name: String(row.name ?? ''),
      type: row.type === 'lxc' ? ('lxc' as const) : ('qemu' as const),
      status: String(row.status ?? ''),
      pool: typeof row.pool === 'string' ? row.pool : null,
      node: String(row.node ?? ''),
      maxmem: Number(row.maxmem) || 0,
      maxdisk: Number(row.maxdisk) || 0,
    }))
    .sort((a, b) => a.vmid - b.vmid)
}

const mb = (bytes: number) => `${Math.floor(bytes / 1024 / 1024)}MB`
const gb = (bytes: number) => `${Math.floor(bytes / 1024 / 1024 / 1024)}GB`
const pad = (value: string | number, width: number) => String(value).padEnd(width)

export function listLines(guests: Guest[]): string[] {
  return [
    `${pad('VMID', 6)} ${pad('NAME', 25)} ${pad('STATUS', 10)} ${pad('RAM', 8)} ${pad('DISK', 8)}`,
    `${pad('----', 6)} ${pad('----', 25)} ${pad('------', 10)} ${pad('---', 8)} ${pad('----', 8)}`,
    ...guests.map(
      (g) =>
        `${pad(g.vmid, 6)} ${pad(g.name, 25)} ${pad(g.status, 10)} ${pad(mb(g.maxmem), 8)} ${pad(gb(g.maxdisk), 8)}`,
    ),
  ]
}

/** Nightshift's asset id when the guest is parked or lab tier (its board shows who runs it), else null. */
export function labAsset(vmid: string, registry: string): string | null {
  try {
    const findings = JSON.parse(readFileSync(registry, 'utf8')).findings ?? []
    const rows =
      findings.find((f: { code?: string }) => f.code === 'assets.registry')?.details?.assets ?? []
    const row = rows.find(
      (r: Record<string, unknown>) =>
        String(r.vmid) === vmid &&
        r.kind !== 'template' &&
        (r.presence === 'parked' || r.tier === 'lab'),
    )
    return row ? String(row.id ?? row.vmid) : null
  } catch {
    return null
  }
}

export function snapshotName(now = new Date()): string {
  return `snap-${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`
}

const vmId = (vmid: string | undefined) => {
  if (!vmid || !/^[1-9][0-9]{2,8}$/.test(vmid))
    throw new Refusal(`VM IDs are numbers from 100 (got ${vmid ?? 'none'})`, 2)
  return vmid
}

const option = (rest: string[], flag: string) =>
  rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined

/** `start`'s Nightshift lab-use declaration; an empty --reason (st passes one) falls back to the default. */
export const labUse = (vmid: string, rest: string[]) => ({
  reason: option(rest, '--reason') || `aico vm start ${vmid}`,
  hours: Number(option(rest, '--hours')) || ops.vm.labHours,
})

export async function vm(
  argv: string[],
  call: VmOp,
  run: Runner,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const [verb, rawId, ...rest] = argv
  switch (verb) {
    case 'list':
      for (const line of listLines(guestRows(await call('list_vms')))) out(line)
      return 0
    case 'status': {
      const vmid = vmId(rawId)
      const data = ((await call('status', vmid)) ?? {}) as Record<string, unknown>
      out(
        `VM ${data.vmid ?? vmid} (${data.name ?? '?'}): ${data.status ?? '?'} | CPU: ${Math.floor(Number(data.cpu || 0) * 100)}% | ` +
          `RAM: ${mb(Number(data.mem) || 0)}/${mb(Number(data.maxmem) || 0)} | Uptime: ${data.uptime ?? 0}s`,
      )
      return 0
    }
    case 'start':
    case 'stop': {
      const vmid = vmId(rawId)
      await call(verb, vmid)
      out(`VM ${vmid} ${verb === 'start' ? 'started' : 'stopped'}`)
      const asset = verb === 'start' ? labAsset(vmid, ops.vm.labRegistry) : null
      if (asset) {
        const { reason, hours } = labUse(vmid, rest)
        const declared = run('nightshift', [
          'lab-use',
          'start',
          asset,
          '--hours',
          String(hours),
          '--reason',
          reason,
        ])
        if (declared.code === 0) out(`Nightshift: ${declared.out.trim() || `declared ${asset}`}`)
        else
          err(
            `Warning: Nightshift lab-use declaration for ${asset} failed (${tail(declared, 1)}); started anyway`,
          )
      }
      return 0
    }
    case 'snapshot': {
      const vmid = vmId(rawId)
      const name = rest[0] ?? snapshotName()
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(name) || name === 'current')
        throw new Refusal(
          'Snapshot names are 2 to 40 letters, digits, - or _, starting with a letter',
          2,
        )
      out(`Creating snapshot '${name}' on VM ${vmid}...`)
      await call('snapshot', vmid, {
        name,
        description: `Auto-snapshot ${new Date().toISOString()}`,
      })
      out(`Done: ${name}`)
      return 0
    }
    default:
      err(
        'Usage: aico vm list | status ID | start ID [--hours H --reason R] | stop ID | snapshot ID [NAME]',
      )
      return 2
  }
}
