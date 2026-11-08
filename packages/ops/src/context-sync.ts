// `aico context-sync run`: the memories, prompts, roles and launch policy in this machine's context database, copied to
// the other full Aico machines (the standby) over the fleet link (`tether fleet exec`, like the repo copies in
// wip-mirror.ts). This machine is the writer; a copy is replaced as a whole, and anything the copy wrote itself
// is kept aside by the receiver (packages/context/src/replica.ts). The paired phones travel with it (merged,
// not replaced). The interval is the job in packages/jobs.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contextDbPath,
  exportReplica,
  importMemories,
  type Memory,
  openContext,
  readReplicaState,
  replicaHash,
} from '@aico/context'
import { requestExec } from '@aico/fleet/exec'
import { fullPeers } from '@aico/fleet/peers'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { writeFileDurable } from '@aico/shared/durable-file'
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
  const ownHash = () => {
    const db = openContext(dbPath)
    try {
      return replicaHash(db)
    } finally {
      db.close()
    }
  }
  let hash = ownHash()
  const aico = (args: string) => ['sh', '-c', `cd "$HOME" && ${config.peerAico} ${args}`]
  const lines: string[] = []
  let failed = false
  let dir: string | null = null
  let snapshot: Buffer | null = null
  for (const peer of peers) {
    const asked = await requestExec(peer.exec, aico('context replica hash'), Buffer.alloc(0))
    let theirs: { hash: string; copy: boolean; changed?: boolean } | null = null
    try {
      theirs = JSON.parse(lastLine(asked.stdout))
    } catch {}
    // No answer at all: the machine is off or its link is down, not failing. The next run catches it up.
    if (unanswered(asked)) {
      lines.push(`${peer.name}: not connected; the next run catches it up`)
      continue
    }
    if (asked.code !== 0 || !theirs) {
      failed = true
      lines.push(
        `${peer.name}: could not read its context (${lastLine(asked.output) || `exit ${asked.code}`}); it may not have this Aico release yet`,
      )
      continue
    }
    // Memories saved on the standby while this machine was off come over before the copy overwrites them.
    if (theirs.changed) {
      const taken = await takeStandbyMemories(peer, aico, dbPath)
      if (taken.line) lines.push(taken.line)
      if (taken.failed) failed = true
      if (taken.added) {
        hash = ownHash()
        snapshot = null
      }
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
    if (unanswered(sent)) {
      lines.push(`${peer.name}: the link dropped; the next run catches it up`)
      continue
    }
    if (sent.code !== 0) failed = true
    lines.push(
      `${peer.name}: ${lastLine(sent.code === 0 ? sent.stdout : sent.output) || `exit ${sent.code}`}`,
    )
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  const phones = await syncPhones(peers, aico, env)
  if (phones.failed) failed = true
  lines.push(...phones.lines)
  const canary = await syncCanaryCursor(peers, aico, env)
  if (canary.failed) failed = true
  lines.push(...canary.lines)
  console.log(lines.join('; '))
  return failed ? 1 : 0
}

/**
 * The memories a standby saved itself since it last took a copy (`aico context replica memories`) are added
 * here, once: an id this machine already has is skipped, so what was edited in both places stays as it is
 * here and a second run adds nothing. Memories only; prompts and roles are not taken.
 */
export async function takeStandbyMemories(
  peer: { name: string; exec: string },
  aico: (args: string) => string[],
  dbPath: string,
  exec: typeof requestExec = requestExec,
  now: () => Date = () => new Date(),
): Promise<{ added: number; failed: boolean; line: string | null }> {
  const asked = await exec(peer.exec, aico('context replica memories'), Buffer.alloc(0))
  if (unanswered(asked)) return { added: 0, failed: false, line: null }
  let memories: Memory[] | null = null
  try {
    const parsed = JSON.parse(lastLine(asked.stdout))
    if (Array.isArray(parsed)) memories = parsed
  } catch {}
  if (asked.code !== 0 || !memories)
    return {
      added: 0,
      failed: true,
      line: `${peer.name}: could not read its memories (${lastLine(asked.output) || `exit ${asked.code}`})`,
    }
  if (!memories.length) return { added: 0, failed: false, line: null }
  const db = openContext(dbPath)
  let added: number
  try {
    added = importMemories(db, memories, now().toISOString())
  } finally {
    db.close()
  }
  return {
    added,
    failed: false,
    line: added
      ? `${peer.name}: Took ${added} ${added === 1 ? 'memory' : 'memories'} saved on the standby`
      : null,
  }
}

/** `requestExec` found no peer, or lost it before the command reported an exit status. */
function unanswered(result: { ended: boolean }): boolean {
  return !result.ended
}

/**
 * The paired phones go with the context: the phone app signs its calls with its own key, and whichever
 * Aico answers has to know that key. Each peer merges what it is sent and answers with the result, so
 * a token the phone gave the standby while this machine was off comes back here.
 */
function phonesReadable(path: string): boolean {
  try {
    return Array.isArray(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return false
  }
}

export async function syncPhones(
  peers: { name: string; exec: string }[],
  aico: (args: string) => string[],
  env: NodeJS.ProcessEnv,
  exec: typeof requestExec = requestExec,
): Promise<{ lines: string[]; failed: boolean }> {
  const path =
    env.AICO_PHONE_DEVICES_FILE?.trim() ||
    join(env.AICO_DATA_DIR || expandHome(config.dataDir), 'phones.json')
  if (!existsSync(path)) return { lines: [], failed: false }
  const lines: string[] = []
  let failed = false
  for (const peer of peers) {
    if (!phonesReadable(path)) {
      // Pairing and pushes refuse an unreadable list (never "no phones"): the peer's copy mends it.
      const copy = await exec(peer.exec, aico('phones dump'), Buffer.alloc(0))
      if (unanswered(copy)) continue
      let phones: unknown = null
      try {
        phones = JSON.parse(lastLine(copy.stdout))
      } catch {}
      if (copy.code === 0 && Array.isArray(phones) && phones.length) {
        writeFileDurable(path, JSON.stringify(phones), { mode: 0o600 })
        lines.push(`${peer.name}: the phone list here could not be read; took its ${phones.length}`)
      } else {
        failed = true
        lines.push(`${peer.name}: the phone list here could not be read, and it has none to give`)
      }
      continue
    }
    const sent = await exec(peer.exec, aico('phones merge'), readFileSync(path))
    if (unanswered(sent)) continue
    let merged: unknown = null
    try {
      merged = JSON.parse(lastLine(sent.stdout))
    } catch {}
    if (sent.code !== 0 || !Array.isArray(merged)) {
      failed = true
      lines.push(
        `${peer.name}: could not take the phones (${lastLine(sent.output) || `exit ${sent.code}`})`,
      )
      continue
    }
    writeFileDurable(path, JSON.stringify(merged), { mode: 0o600 })
    // Only now does the peer count the merge as done: a link that dropped before this keeps its new phones.
    await exec(peer.exec, aico('phones merge-done'), Buffer.alloc(0))
    lines.push(`${peer.name}: ${merged.length} phone${merged.length === 1 ? '' : 's'} in step`)
  }
  return { lines, failed }
}

/**
 * The canary cursor (the newest hit already looked at, per token; packages/web-server canary-poll.ts)
 * goes the same way, newest per token winning on both sides. Without it the machine that comes back
 * would alert hits the other one already did.
 */
export async function syncCanaryCursor(
  peers: { name: string; exec: string }[],
  aico: (args: string) => string[],
  env: NodeJS.ProcessEnv,
  exec: typeof requestExec = requestExec,
): Promise<{ lines: string[]; failed: boolean }> {
  const path = join(env.AICO_DATA_DIR || expandHome(config.dataDir), 'canary', 'poll.json')
  if (!existsSync(path)) return { lines: [], failed: false }
  const lines: string[] = []
  let failed = false
  for (const peer of peers) {
    const sent = await exec(peer.exec, aico('phones canary-merge'), readFileSync(path))
    if (unanswered(sent)) continue
    let merged: Record<string, number> | null = null
    try {
      const parsed = JSON.parse(lastLine(sent.stdout))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) merged = parsed
    } catch {}
    if (sent.code !== 0 || !merged) {
      failed = true
      lines.push(
        `${peer.name}: could not take the canary cursor (${lastLine(sent.output) || `exit ${sent.code}`})`,
      )
      continue
    }
    // Newest per token again: the poller may have moved the file while the peer answered.
    let ours: Record<string, number> = {}
    try {
      ours = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
    for (const [token, at] of Object.entries(ours))
      if (Number.isFinite(at)) merged[token] = Math.max(merged[token] ?? at, at)
    writeFileDurable(path, JSON.stringify(merged), { mode: 0o600 })
    lines.push(`${peer.name}: canary cursor in step`)
  }
  return { lines, failed }
}
