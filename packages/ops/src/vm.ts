// `aico vm list|status|start|stop|snapshot`: Proxmox guests through SummitFlow's backend route
// (`POST /api/vm/op`), the path `st vm` used: the backend holds the Proxmox API token, and that token's
// pool rights (lab pool full, ops pool power, power pool power, the rest read-only) are what Proxmox
// enforces, so nothing here decides which guest may be powered or snapshotted. The verbs and output
// match `st vm`. Deleting a guest or a snapshot is not here: that stays owner-run.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/** One `POST /api/vm/op` call: the op's result, or a Refusal carrying Proxmox's own error. */
export type VmOp = (op: string, vmid?: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * The caller's SummitFlow identity header, the one `st` sends: the owner token if its file is readable,
 * else the agent token (each file is the env var's path or its default under the home directory).
 */
export function summitflowIdentity(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Record<string, string> {
  const sources: [string, string, string][] = [
    [
      'SUMMITFLOW_OWNER_TOKEN_FILE',
      '.config/credstore/summitflow/owner-token',
      'X-SummitFlow-Owner-Token',
    ],
    ['SUMMITFLOW_AGENT_TOKEN_FILE', '.config/agent-tokens/summitflow', 'X-SummitFlow-Agent-Token'],
  ]
  for (const [name, fallback, header] of sources) {
    try {
      const token = readFileSync(env[name]?.trim() || join(home, fallback), 'utf8').trim()
      if (token) return { [header]: token }
    } catch {
      // unreadable or missing: try the next one
    }
  }
  return {}
}

/** The backend route `st vm` calls when it holds no Proxmox token (ST_API_BASE, else data/ops.json). */
export function routeOp(env: NodeJS.ProcessEnv = process.env, fetcher = fetch): VmOp {
  const url = `${(env.ST_API_BASE?.trim() || ops.vm.apiBase).replace(/\/$/, '')}/vm/op`
  return async (op, vmid, args = {}) => {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Request-Source': 'aico-vm',
          ...summitflowIdentity(env),
        },
        body: JSON.stringify({ op, vmid: vmid ?? null, args }),
        signal: AbortSignal.timeout(ops.vm.timeoutSeconds * 1000),
      })
    } catch (error) {
      throw new Refusal(`Proxmox backend route failed: ${(error as Error).message}`)
    }
    const text = await response.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {}
    if (!response.ok) {
      const detail = (body as { detail?: unknown; message?: unknown } | null)?.detail
      const message =
        typeof detail === 'string'
          ? detail
          : typeof (detail as { message?: unknown } | undefined)?.message === 'string'
            ? (detail as { message: string }).message
            : typeof (body as { message?: unknown } | null)?.message === 'string'
              ? (body as { message: string }).message
              : text.trim() || `HTTP ${response.status}`
      throw new Refusal(message)
    }
    return (body as { result?: unknown } | null)?.result
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
