import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { shoppingPolicy } from './shopping-repair-policy'

interface Runner {
  run(argv: string[], cwd?: string): Promise<{ code: number; output: string }>
}

export function replayId(incident: string, request: string): string {
  return createHash('sha256').update(`${incident}\0${request}`).digest('hex')
}

/** Enqueue in Portfolio's host-local coordinator API using the deployed VM identity. */
export async function queuePortfolioReplay(
  io: Runner,
  projectRoot: string,
  request: string,
  replay: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(request) || !/^[a-f0-9]{64}$/.test(replay)) return false
  try {
    const identity = JSON.parse(
      readFileSync(join(projectRoot, 'project.identity.json'), 'utf8'),
    ) as {
      runtime?: {
        backend_port?: unknown
        deployment?: { kind?: unknown; ssh_host?: unknown; vmid?: unknown; user?: unknown }
      }
    }
    const deployment = identity.runtime?.deployment
    const port = identity.runtime?.backend_port
    if (
      deployment?.kind !== 'proxmox' ||
      typeof deployment.ssh_host !== 'string' ||
      !/^[A-Za-z0-9.-]+$/.test(deployment.ssh_host) ||
      typeof deployment.user !== 'string' ||
      !/^[a-z_][a-z0-9_-]*$/.test(deployment.user) ||
      !Number.isSafeInteger(deployment.vmid) ||
      !Number.isSafeInteger(port) ||
      Number(port) < 1 ||
      Number(port) > 65535
    )
      return false
    const addresses = await io.run([
      'ssh',
      '-o',
      'BatchMode=yes',
      deployment.ssh_host,
      'qm',
      'guest',
      'cmd',
      String(deployment.vmid),
      'network-get-interfaces',
    ])
    if (addresses.code) return false
    const interfaces = JSON.parse(addresses.output) as Array<{
      name?: unknown
      'ip-addresses'?: Array<{ 'ip-address-type'?: unknown; 'ip-address'?: unknown }>
    }>
    if (!Array.isArray(interfaces)) return false
    const address = interfaces
      .filter(
        (iface) => typeof iface.name === 'string' && !/^(lo|docker|br-|veth)/.test(iface.name),
      )
      .flatMap((iface) => (Array.isArray(iface['ip-addresses']) ? iface['ip-addresses'] : []))
      .find(
        (item) =>
          item['ip-address-type'] === 'ipv4' &&
          typeof item['ip-address'] === 'string' &&
          isIP(item['ip-address']) === 4,
      )?.['ip-address']
    if (typeof address !== 'string') return false
    // SSH invokes a remote shell, so the fixed JSON is explicitly quoted; both identifiers are validated above.
    const body = `'${JSON.stringify({ replay_id: replay })}'`
    const result = await io.run([
      'ssh',
      '-o',
      'BatchMode=yes',
      `${deployment.user}@${address}`,
      'curl',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      '15',
      '--header',
      "'Content-Type: application/json'",
      '--data',
      body,
      `http://127.0.0.1:${port}/api/shopping/repair/${request}/replay`,
    ])
    if (result.code) return false
    const response = JSON.parse(result.output) as {
      request_id?: unknown
      replay_id?: unknown
      state?: unknown
    }
    return (
      response.request_id === request &&
      response.replay_id === replay &&
      ['pending', 'running', 'complete'].includes(String(response.state))
    )
  } catch {
    return false
  }
}

/** Ask Dadbot to requeue its original durable job; no assertion is made or stored. */
export async function queueDadbotReplay(
  io: Runner,
  request: string,
  replay: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(request) || !/^[a-f0-9]{64}$/.test(replay)) return false
  const policy = shoppingPolicy('dadbot')
  const config = policy.replay
  if (!policy.sshHost || !config) return false
  const result = await io.run([
    'ssh',
    '-o',
    'BatchMode=yes',
    policy.sshHost,
    'sudo',
    '-n',
    '-u',
    config.user,
    'env',
    `PYTHONPATH=${config.pythonPath}`,
    config.python,
    '-m',
    config.module,
    request,
    replay,
    '--config',
    config.config,
  ])
  if (result.code) return false
  try {
    const response = JSON.parse(result.output) as {
      request_id?: unknown
      replay_id?: unknown
      state?: unknown
    }
    return (
      response.request_id === request &&
      response.replay_id === replay &&
      ['queued', 'already_queued'].includes(String(response.state))
    )
  } catch {
    return false
  }
}
