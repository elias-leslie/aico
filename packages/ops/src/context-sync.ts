// `aico context-sync run`: the memories, prompts, roles and launch policy in this machine's context database, copied to
// the other full Aico machines (the standby) over the fleet link (`tether fleet exec`, like the repo copies in
// wip-mirror.ts). This machine is the writer; a copy is replaced as a whole, and anything the copy wrote itself
// is kept aside by the receiver (packages/context/src/replica.ts). The interval is the job in packages/jobs.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contextDbPath,
  exportReplica,
  openContext,
  readReplicaState,
  replicaHash,
} from '@aico/context'
import { requestExec } from '@aico/fleet/exec'
import { fullPeers } from '@aico/fleet/peers'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import config from '../data/context-sync.json' with { type: 'json' }
import { Refusal } from './deploy'
import { expandHome } from './sh'

const USAGE = `Usage:
  aico context-sync run    copy memories, prompts, roles and the launch policy to the other full Aico machines`

const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).pop() ?? ''

export async function contextSync(argv: string[], env = process.env): Promise<number> {
  const [verb, ...rest] = argv
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(USAGE)
    return 0
  }
  if (verb !== 'run' || rest.length)
    throw new Refusal(`aico context-sync: unknown command\n${USAGE}`, 2)
  const dbPath = contextDbPath(env.AICO_DATA_DIR || expandHome(config.dataDir))
  const state = readReplicaState(dbPath)
  if (state)
    throw new Refusal(
      `This machine's context is itself a copy from ${state.from}; it does not send. Run the sync there.`,
    )
  const settings = readSettings(env, '')
  if (!settings) throw new Refusal('This machine is not part of a fleet.')
  const { role, peers } = fullPeers(settings, readPins(settings.allowlist))
  if (role !== 'full') throw new Refusal('Only a full Aico machine sends its context.')
  if (!peers.length) {
    console.log('No other full Aico in the fleet; nothing to copy to.')
    return 0
  }
  const db = openContext(dbPath)
  let hash: string
  try {
    hash = replicaHash(db)
  } finally {
    db.close()
  }
  const aico = (args: string) => ['sh', '-c', `cd "$HOME" && ${config.peerAico} ${args}`]
  const lines: string[] = []
  let failed = false
  let dir: string | null = null
  let snapshot: Buffer | null = null
  for (const peer of peers) {
    const asked = await requestExec(peer.exec, aico('context replica hash'), Buffer.alloc(0))
    let theirs: { hash: string; copy: boolean } | null = null
    try {
      theirs = JSON.parse(lastLine(asked.stdout))
    } catch {}
    if (asked.code !== 0 || !theirs) {
      failed = true
      lines.push(
        `${peer.name}: could not read its context (${lastLine(asked.output) || `exit ${asked.code}`}); it may not have this Aico release yet`,
      )
      continue
    }
    if (theirs.copy && theirs.hash === hash) {
      lines.push(`${peer.name}: already the same`)
      continue
    }
    if (!snapshot) {
      dir = mkdtempSync(join(tmpdir(), 'aico-context-sync-'))
      const file = join(dir, 'snapshot')
      exportReplica(dbPath, file)
      snapshot = readFileSync(file)
    }
    const sent = await requestExec(
      peer.exec,
      aico(`context replica apply --from ${settings.machine}`),
      snapshot,
    )
    if (sent.code !== 0) failed = true
    lines.push(
      `${peer.name}: ${lastLine(sent.code === 0 ? sent.stdout : sent.output) || `exit ${sent.code}`}`,
    )
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  console.log(lines.join('; '))
  return failed ? 1 : 0
}
