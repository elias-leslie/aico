// Proxmox VM operations use the scoped API token held in Aico Logins (client: @aico/fleet/proxmox).
// Proxmox enforces its pool rights; no SummitFlow service is involved.

import {
  type PveRequest as FleetPveRequest,
  pveRequest as fleetPveRequest,
  waitTask as fleetWaitTask,
  isUpid,
  PveError,
  type PveTransport,
  proxmoxConfig,
} from '@aico/fleet/proxmox'
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

/** The shared Proxmox client; its failures surface here as Refusals (the CLI's exit codes). */
export type PveRequest = FleetPveRequest

export function pveRequest(
  env: NodeJS.ProcessEnv = process.env,
  transport: PveTransport = {},
): PveRequest {
  const call = fleetPveRequest(env, { timeoutMs: ops.vm.timeoutSeconds * 1000, ...transport })
  return async (method, path, body) => {
    try {
      return await call(method, path, body)
    } catch (error) {
      throw error instanceof PveError ? new Refusal(error.message) : error
    }
  }
}

async function waitTask(call: PveRequest, node: string, task: string): Promise<void> {
  try {
    await fleetWaitTask(call, node, task, ops.vm.timeoutSeconds * 1000)
  } catch (error) {
    throw error instanceof PveError ? new Refusal(error.message) : error
  }
}

const STORAGE = /^[a-z0-9][a-z0-9-]{0,62}$/
const SNAPSHOT = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/

/** Newest start time (epoch seconds) of one task type for a guest, or null when none is recorded. */
async function latestTask(
  call: PveRequest,
  guest: Guest,
  type: 'qmstart' | 'qmrollback',
): Promise<number | null> {
  const rows = (await call(
    'GET',
    `/nodes/${encodeURIComponent(guest.node)}/tasks?vmid=${guest.vmid}&typefilter=${type}&limit=100`,
  )) as { type?: string; starttime?: number }[]
  const times = (Array.isArray(rows) ? rows : [])
    .filter((row) => row.type === type && Number.isInteger(row.starttime))
    .map((row) => row.starttime as number)
  return times.length ? Math.max(...times) : null
}

export interface Observation {
  vms: {
    vmid: number
    name: string
    status: string
    uptime: number
    lock: string | null
    snapshots: string[]
    latest_tasks: { qmstart: number | null; qmrollback: number | null }
  }[]
  storage: { name: string; used: number; total: number }
}

/** Read-only inventory of the named QEMU guests plus one storage's use. */
async function observe(
  call: PveRequest,
  guests: Guest[],
  ids: string[],
  storage: string,
): Promise<Observation> {
  if (!STORAGE.test(storage)) throw new Refusal('Invalid Proxmox storage name', 2)
  const vms: Observation['vms'] = []
  for (const id of ids) {
    const guest = guests.find((row) => String(row.vmid) === id)
    if (!guest || guest.type !== 'qemu') throw new Refusal(`No visible Proxmox VM ${id}`)
    const base = `/nodes/${encodeURIComponent(guest.node)}/qemu/${guest.vmid}`
    const current = (await call('GET', `${base}/status/current`)) as Record<string, unknown>
    const snapshots = (await call('GET', `${base}/snapshot`)) as { name?: string }[]
    vms.push({
      vmid: guest.vmid,
      name: String(current.name ?? guest.name),
      status: String(current.status ?? guest.status),
      uptime: Number(current.uptime) || 0,
      lock: current.lock ? String(current.lock) : null,
      snapshots: (Array.isArray(snapshots) ? snapshots : [])
        .map((row) => String(row.name))
        .filter((name) => name !== 'current'),
      latest_tasks: {
        qmstart: await latestTask(call, guest, 'qmstart'),
        qmrollback: await latestTask(call, guest, 'qmrollback'),
      },
    })
  }
  const use = (await call(
    'GET',
    `/nodes/${encodeURIComponent(proxmoxConfig.node)}/storage/${storage}/status`,
  )) as { used?: number; total?: number }
  return {
    vms,
    storage: { name: storage, used: Number(use.used) || 0, total: Number(use.total) || 0 },
  }
}

/**
 * Roll a stopped QEMU guest back to a named snapshot and leave it stopped. The caller names the
 * expected guest name; a mismatch, a running or locked guest, or a missing snapshot refuses before
 * anything is written.
 */
async function resetGuest(
  call: PveRequest,
  guest: Guest,
  name: string,
  snapshot: string,
): Promise<{ vmid: number; name: string; snapshot: string; status: string }> {
  if (guest.type !== 'qemu')
    throw new Refusal(`VM ${guest.vmid} is a container; reset needs a VM`, 2)
  if (!SNAPSHOT.test(snapshot) || snapshot === 'current')
    throw new Refusal('Invalid snapshot name', 2)
  const base = `/nodes/${encodeURIComponent(guest.node)}/qemu/${guest.vmid}`
  const current = (await call('GET', `${base}/status/current`)) as Record<string, unknown>
  if (current.name !== name || guest.name !== name)
    throw new Refusal(`VM ${guest.vmid} is not named ${name}; nothing was reset`)
  if (current.status !== 'stopped')
    throw new Refusal(
      `VM ${guest.vmid} is ${String(current.status)}; reset only touches stopped guests`,
    )
  if (current.lock) throw new Refusal(`VM ${guest.vmid} is locked (${String(current.lock)})`)
  const snapshots = (await call('GET', `${base}/snapshot`)) as { name?: string }[]
  if (!(Array.isArray(snapshots) ? snapshots : []).some((row) => row.name === snapshot))
    throw new Refusal(`VM ${guest.vmid} has no snapshot ${snapshot}`)
  const task = await call('POST', `${base}/snapshot/${encodeURIComponent(snapshot)}/rollback`)
  if (isUpid(task)) await waitTask(call, guest.node, task)
  let after = (await call('GET', `${base}/status/current`)) as Record<string, unknown>
  if (after.status !== 'stopped') {
    // A snapshot with saved memory resumes running; the guest must end stopped.
    const stop = await call('POST', `${base}/status/stop`)
    if (isUpid(stop)) await waitTask(call, guest.node, stop)
    after = (await call('GET', `${base}/status/current`)) as Record<string, unknown>
  }
  if (after.name !== name || after.status !== 'stopped')
    throw new Refusal(`VM ${guest.vmid} was not verified stopped as ${name} after reset`)
  return { vmid: guest.vmid, name, snapshot, status: 'stopped' }
}

/** A direct PVE API operation. Proxmox continues to enforce the scoped token's pool rights. */
export function routeOp(
  env: NodeJS.ProcessEnv = process.env,
  call: PveRequest = pveRequest(env),
): VmOp {
  return async (op, vmid, args = {}) => {
    const guests = guestRows(await call('GET', '/cluster/resources?type=vm'))
    if (op === 'list_vms') return guests
    if (op === 'observe')
      return observe(call, guests, (args.ids as string[]) ?? [], String(args.storage ?? ''))
    const guest = guests.find((row) => String(row.vmid) === vmid)
    if (!guest) throw new Refusal(`No visible Proxmox guest ${vmid}`)
    if (op === 'reset') return resetGuest(call, guest, String(args.name), String(args.snapshot))
    const base = `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`
    if (op === 'status')
      return {
        ...((await call('GET', `${base}/status/current`)) as object),
        vmid: guest.vmid,
        name: guest.name,
      }
    if (op === 'ip') {
      if (guest.type !== 'qemu')
        throw new Refusal(`VM ${guest.vmid} is a container; ip reads the VM guest agent`, 2)
      // The guest agent reports the addresses the VM actually holds (DHCP or static).
      const agent = (await call('GET', `${base}/agent/network-get-interfaces`)) as {
        result?: unknown
      } | null
      return guestAddresses(agent?.result)
    }
    let task: unknown
    if (op === 'start' || op === 'stop' || op === 'shutdown')
      task = await call('POST', `${base}/status/${op}`)
    else if (op === 'snapshot')
      task = await call('POST', `${base}/snapshot`, {
        snapname: args.name,
        description: args.description,
      })
    else throw new Refusal(`Unsupported Proxmox operation ${op}`, 2)
    if (isUpid(task)) await waitTask(call, guest.node, task)
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

/** IPv4 addresses from the guest agent's interface list, loopback and link-local left out. */
export function guestAddresses(interfaces: unknown): string[] {
  const found: string[] = []
  for (const nic of Array.isArray(interfaces) ? (interfaces as Record<string, unknown>[]) : []) {
    for (const addr of Array.isArray(nic['ip-addresses'])
      ? (nic['ip-addresses'] as Record<string, unknown>[])
      : []) {
      const ip = String(addr['ip-address'] ?? '')
      if (
        addr['ip-address-type'] === 'ipv4' &&
        !ip.startsWith('127.') &&
        !ip.startsWith('169.254.') &&
        !found.includes(ip)
      )
        found.push(ip)
    }
  }
  return found
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

/** `start`'s lab-use declaration (host-steward lab-use, by VM id); an empty --reason (st passes one) falls back to the default. */
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
    case 'ip': {
      const vmid = vmId(rawId)
      const addresses = (await call('ip', vmid)) as string[]
      if (!addresses.length) {
        err(`VM ${vmid} reports no IPv4 address`)
        return 1
      }
      for (const address of addresses) out(address)
      return 0
    }
    case 'start':
    case 'shutdown':
    case 'stop': {
      const vmid = vmId(rawId)
      await call(verb, vmid)
      out(`VM ${vmid} ${verb === 'start' ? 'started' : 'stopped'}`)
      if (verb === 'start') {
        const { reason, hours } = labUse(vmid, rest)
        const declared = run('host-steward', [
          'lab-use',
          'start',
          vmid,
          '--hours',
          String(hours),
          '--reason',
          reason,
        ])
        if (declared.code === 0) out(`host check: ${declared.out.trim() || `declared ${vmid}`}`)
        else
          err(
            `Warning: lab-use declaration for VM ${vmid} failed (${tail(declared, 1)}); started anyway`,
          )
      }
      return 0
    }
    case 'observe': {
      // Read-only inventory as one JSON document: aico vm observe ID... --storage NAME
      const positional = [rawId, ...rest].filter(
        (v, i, all) => v && !v.startsWith('--') && !all[i - 1]?.startsWith('--'),
      )
      const ids = positional.map(vmId)
      const storage = option(rest, '--storage')
      if (!ids.length || !storage)
        throw new Refusal('Usage: aico vm observe ID... --storage NAME', 2)
      out(JSON.stringify(await call('observe', undefined, { ids, storage })))
      return 0
    }
    case 'reset': {
      // Roll a stopped VM back to a snapshot, verified by name; leaves it stopped.
      const vmid = vmId(rawId)
      const name = option(rest, '--name')
      const snapshot = option(rest, '--snapshot')
      if (!name || !snapshot)
        throw new Refusal('Usage: aico vm reset ID --name NAME --snapshot SNAPSHOT', 2)
      out(JSON.stringify(await call('reset', vmid, { name, snapshot })))
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
      err(`aico vm: unknown command ${verb}; aico vm --help lists them`)
      return 2
  }
}
