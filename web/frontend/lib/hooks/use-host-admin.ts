'use client'

import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect } from 'react'
import type { TerminalSession } from './use-terminal-sessions'

/** A tool's sign-in state on a host. `unknown` is never "signed out". */
export type LoginState = 'signed_in' | 'needs_sign_in' | 'expired' | 'unknown'

export interface LoginCredential {
  name: string
  rotates: boolean
  state: LoginState
  /** `agent-hub` (served at launch) or `host:<path>` (a login on the host's disk). */
  source: string
  detail?: string
  expires_at?: string | null
}

export interface ToolLogin {
  tool: string
  state: LoginState
  source: string
  credentials: LoginCredential[]
}

export interface ToolActions {
  signIn: boolean
  signOut: 'revoke' | 'command' | 'session' | null
}

export interface HostLogins {
  host: string
  /** `reachable`, or why Agent Hub can't be reached from the host. */
  agent_hub: string
  tools: ToolLogin[]
  checkedAt: number
  actions: Record<string, ToolActions>
}

export interface HostActionAnswer {
  host?: string
  state?: string
  session?: TerminalSession
  signedOut?: boolean
  note?: string
}

/** A failed host call, with the status the app can branch on (409: busy). */
export class HostCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const hostUrl = (host: string, rest = '') =>
  `/api/hosts/${encodeURIComponent(host)}${rest}`

/** POST a host action; a failure keeps the server's plain-words detail. */
export async function hostPost(
  path: string,
  body: Record<string, unknown> | undefined,
  fallback: string,
): Promise<HostActionAnswer> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let parsed: (HostActionAnswer & { detail?: string }) | undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!res.ok) throw new HostCallError(parsed?.detail || fallback, res.status)
  return parsed ?? {}
}

export const powerHost = (host: string, action: 'on' | 'off', force = false) =>
  hostPost(
    hostUrl(host, '/power'),
    force ? { action, force } : { action },
    `Couldn’t power ${action} ${host}`,
  )

export const trustHost = (host: string) =>
  hostPost(hostUrl(host, '/trust'), undefined, `Couldn’t trust ${host}`)

export const toolAction = (
  host: string,
  tool: string,
  action: 'sign_in' | 'sign_out',
) =>
  hostPost(
    hostUrl(host, `/logins/${encodeURIComponent(tool)}`),
    { action },
    action === 'sign_in'
      ? `Couldn’t start sign-in on ${host}`
      : `Couldn’t sign out on ${host}`,
  )

/** Each tool's sign-in state on a connected host. Idle while the host is
 * away: there is nothing to ask. Fails with Tether's reason. */
export function useHostLogins(host: string, enabled: boolean) {
  return useQuery({
    queryKey: ['host-logins', host],
    queryFn: async (): Promise<HostLogins> => {
      const res = await fetch(hostUrl(host, '/logins'))
      if (!res.ok) {
        const error = await res
          .json()
          .catch(() => ({ detail: undefined }) as { detail?: string })
        throw new HostCallError(
          error.detail || 'No answer from the host',
          res.status,
        )
      }
      return res.json()
    },
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

/** Sign-in sessions opened from the Hosts sheet, by session id, with the host
 * to re-check when each ends. Module-level: the sheet is gone by then. */
const watchedSignIns = new Map<
  string,
  { host: string; seen: boolean; queryClient: QueryClient }
>()

export function watchSignIn(
  sessionId: string,
  host: string,
  queryClient: QueryClient,
) {
  watchedSignIns.set(sessionId, { host, seen: false, queryClient })
}

/** Refetch a host's sign-in state when a sign-in session from the Hosts sheet
 * ends (it leaves the list, or stops being alive). Mount once, beside the
 * session list. */
export function useSignInWatch(
  sessions: Pick<TerminalSession, 'id' | 'is_alive'>[],
  loaded: boolean,
) {
  useEffect(() => {
    if (!loaded || watchedSignIns.size === 0) return
    for (const [id, watch] of watchedSignIns) {
      const session = sessions.find((candidate) => candidate.id === id)
      if (session?.is_alive) {
        watch.seen = true
        continue
      }
      // Not yet listed: it has not shown up since the sign-in began.
      if (!session && !watch.seen) continue
      watchedSignIns.delete(id)
      void watch.queryClient.invalidateQueries({
        queryKey: ['host-logins', watch.host],
      })
    }
  }, [sessions, loaded])
}

/** Show a session by id, as the session list does (`?session=`): refresh the
 * list first so a session just created is known when the page switches. */
export function useOpenSession() {
  const router = useRouter()
  const queryClient = useQueryClient()
  return useCallback(
    async (sessionId: string) => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['terminal-sessions'] }),
        queryClient.refetchQueries({ queryKey: ['terminal-panes'] }),
      ]).catch(() => undefined)
      const params = new URLSearchParams(window.location.search)
      params.set('session', sessionId)
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [queryClient, router],
  )
}
