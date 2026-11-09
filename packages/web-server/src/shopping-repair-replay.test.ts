import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { queueDadbotReplay, queuePortfolioReplay, replayId } from './shopping-repair-replay'

it('reuses a stable replay ID and requires the exact remote queue receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shopping-replay-'))
  try {
    writeFileSync(
      join(root, 'project.identity.json'),
      JSON.stringify({
        runtime: {
          backend_port: 8000,
          deployment: { kind: 'proxmox', ssh_host: 'pve', vmid: 180, user: 'operator' },
        },
      }),
    )
    const replay = replayId('incident', 'request-1')
    const calls: string[][] = []
    let wrong = false
    const io = {
      run: async (argv: string[]) => {
        calls.push(argv)
        if (argv.includes('network-get-interfaces'))
          return {
            code: 0,
            output: JSON.stringify([
              {
                name: 'eth0',
                'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.1.2.3' }],
              },
            ]),
          }
        return {
          code: 0,
          output: JSON.stringify({
            request_id: wrong ? 'other' : 'request-1',
            replay_id: replay,
            state: argv.includes('dadbot') ? 'queued' : 'pending',
          }),
        }
      },
    }
    expect(replay).toBe(replayId('incident', 'request-1'))
    expect(await queuePortfolioReplay(io, root, 'request-1', replay)).toBe(true)
    expect(await queueDadbotReplay(io, 'request-1', replay)).toBe(true)
    expect(calls.some((argv) => argv.includes('CF-Access-Jwt-Assertion'))).toBe(false)
    wrong = true
    expect(await queueDadbotReplay(io, 'request-1', replay)).toBe(false)
    expect(await queueDadbotReplay(io, 'request;bad', replay)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
