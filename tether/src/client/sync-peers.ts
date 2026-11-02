// Where Aico's sync sockets are: one per hosts.json entry that has a `sync`
// field, forwarded by that host's link to `<peerDir>/sync.sock` (hub/link.ts).
// Pure, so the apps need no hub import: the daemon's registry code
// (hub/hosts.ts) stays the validator, and a test keeps both readings equal.

import { isAbsolute, join, normalize } from 'node:path'

export interface SyncPeer {
  /** The hosts.json name. */
  name: string
  /** The local end of the link's forward to that host's sync socket. */
  socket: string
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const RESERVED = new Set(['local', 'auto'])
const MAX_SOCKET_BYTES = 107

/** `$TETHER_HOSTS_FILE`, else `$XDG_CONFIG_HOME/tether/hosts.json` (hub/hosts.ts `hostsFilePath`). */
export function hostsFile(env: NodeJS.ProcessEnv, home: string): string {
  if (env.TETHER_HOSTS_FILE) return env.TETHER_HOSTS_FILE
  return join(env.XDG_CONFIG_HOME || join(env.HOME ?? home, '.config'), 'tether', 'hosts.json')
}

/** The hosts that sync, from the text of hosts.json; unusable text or entries are none. */
export function syncPeers(
  text: string,
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): SyncPeer[] {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid ?? process.getuid?.() ?? 0}`
  const peers: SyncPeer[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { name, sync } = item as Record<string, unknown>
    if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) continue
    if (typeof sync !== 'string' || !isAbsolute(sync) || normalize(sync) !== sync) continue
    if (/[\s\0]/.test(sync) || Buffer.byteLength(sync) > MAX_SOCKET_BYTES) continue
    if (peers.some((peer) => peer.name === name)) continue
    peers.push({ name, socket: join(runtime, 'tether', 'peers', name, 'sync.sock') })
  }
  return peers
}
