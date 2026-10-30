// The Hosts panel's main-process side: each remote host's state, power and
// per-tool sign-in, all through Tether's hub (tether docs/api-v1.md "Remote
// hosts"). A sign-in opens a short session on that host in its own window;
// when it ends, every window is told to check that host's sign-in again.

import type { IpcMain } from 'electron'
import {
  type HostInfo,
  type HostLogins,
  hostLogins,
  hostPower,
  hostSignIn,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  trustHost,
} from 'tether/client'

/** A hosts.json host name, as the hub names it. */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TOOL = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A sign-in on a host that is off waits for it to come up. */
const SIGN_IN_TIMEOUT_MS = 300_000

export type HostRow = Pick<HostInfo, 'name' | 'state' | 'since' | 'sessions' | 'error'> & {
  wake: HostInfo['wake'] | null
}

export type { HostLogins }

/** Every answer the renderer gets: the value, or Tether's reason in plain words. */
export type HostResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string }

interface HostPanelDeps {
  tether: TetherClient
  catalog: { upsert(descriptor: SessionDescriptor): void }
  windows: { focusOrReopen(id: string): void }
  /** Tell every window that a host's sign-in may have changed. */
  broadcast(host: string): void
}

function failure(error: unknown): { ok: false; status: number; message: string } {
  if (error instanceof TetherError)
    return {
      ok: false,
      status: error.status,
      message: error.reason ?? `Tether answered ${error.code}`,
    }
  return { ok: false, status: 0, message: 'Aico can’t reach its session service' }
}

async function attempt<T>(work: () => Promise<T>): Promise<HostResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return failure(error)
  }
}

export function createHostPanel(deps: HostPanelDeps) {
  const { tether } = deps
  /** Sign-in sessions this app opened, by session id → host. */
  const signIns = new Map<string, string>()

  function sessionRemoved(id: string): void {
    const host = signIns.get(id)
    if (!host) return
    signIns.delete(id)
    deps.broadcast(host)
  }

  function registerIpc(ipcMain: IpcMain): void {
    ipcMain.handle('hosts:panel', () =>
      attempt(async () =>
        (await tether.hosts()).map(
          (host): HostRow => ({
            name: host.name,
            state: host.state,
            since: host.since,
            sessions: host.sessions,
            error: host.error,
            wake: host.wake ?? null,
          }),
        ),
      ),
    )
    ipcMain.handle('hosts:logins', (_event, host: unknown) => {
      if (typeof host !== 'string' || !HOST_NAME.test(host)) return badInput()
      return attempt(() => hostLogins(tether, host))
    })
    ipcMain.handle('hosts:power', (_event, host: unknown, action: unknown, force: unknown) => {
      if (typeof host !== 'string' || !HOST_NAME.test(host)) return badInput()
      if (action !== 'on' && action !== 'off') return badInput()
      return attempt(() => hostPower(tether, host, action, force === true))
    })
    ipcMain.handle('hosts:trust', (_event, host: unknown) => {
      if (typeof host !== 'string' || !HOST_NAME.test(host)) return badInput()
      return attempt(() => trustHost(tether, host))
    })
    ipcMain.handle('hosts:sign', (_event, host: unknown, tool: unknown, action: unknown) => {
      if (typeof host !== 'string' || !HOST_NAME.test(host)) return badInput()
      if (typeof tool !== 'string' || !TOOL.test(tool)) return badInput()
      if (action !== 'sign_in' && action !== 'sign_out') return badInput()
      return attempt(async () => {
        const answer = await hostSignIn(tether, host, tool, action, {
          origin: 'aico',
          timeoutMs: SIGN_IN_TIMEOUT_MS,
        })
        const session = answer.session
        if (session) {
          signIns.set(session.id, host)
          deps.catalog.upsert(session)
          deps.windows.focusOrReopen(session.id)
        }
        return {
          signedOut: answer.signedOut === true,
          note: answer.note ?? null,
          opened: !!session,
        }
      })
    })
  }

  return { registerIpc, sessionRemoved }
}

function badInput(): HostResult<never> {
  return { ok: false, status: 400, message: 'Invalid request' }
}
