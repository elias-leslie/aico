// The owner's model notice. A session nobody launched (a window the owner
// opened) has no launcher to tell when its model switches or a refusal stops
// it: the owner gets one Aico notice (tray) per switch (contract v1, the same
// path as the waiting notice), resolved when the session is back on its model
// or gone. Launched lanes tell their launcher instead (src/lane-reports.ts),
// unless nobody could take the line (`unheard`).
//
// Only the Tether that knows where Aico is (TETHER_AICO_URL) sends these: it
// sees its own sessions and every remote host's.

import { type WaitingNotice, waitingNotice } from './aico-notice'
import { type ModelSwitch, modelSwitchOf, modelSwitchText } from './model-switch'

export interface ModelNoticeState {
  /** `<host>|<id>` to the notice key and the switch it was sent for. */
  sent: Record<string, { key: string; switchKey: string }>
}

export function readModelNoticeState(raw: string | null): ModelNoticeState {
  const state: ModelNoticeState = { sent: {} }
  try {
    const value = JSON.parse(raw ?? '{}') as { sent?: unknown }
    const sent = value.sent && typeof value.sent === 'object' ? value.sent : {}
    for (const [id, entry] of Object.entries(sent)) {
      const e = entry as { key?: unknown; switchKey?: unknown } | null
      if (typeof e?.key === 'string' && typeof e.switchKey === 'string')
        state.sent[id] = { key: e.key, switchKey: e.switchKey }
    }
  } catch {
    // A damaged setting starts empty.
  }
  return state
}

export interface ModelNoticeDeps {
  send(notice: WaitingNotice): void
  resolve(key: string): void
  origin: string
  state: { read(): ModelNoticeState; write(state: ModelNoticeState): void }
}

/** The part of a descriptor the notice reads. */
export interface ModelNoticeSession {
  id: string
  tool?: unknown
  label?: unknown
  displayTitle?: unknown
  launched?: unknown
  coordinatorId?: unknown
  rootRequestId?: unknown
  modelSwitch?: unknown
}

/** The notice for a switch in a session nobody launched. */
function modelNotice(
  session: ModelNoticeSession,
  change: ModelSwitch,
  origin: string,
): WaitingNotice {
  const name =
    (typeof session.displayTitle === 'string' && session.displayTitle.trim()) ||
    (typeof session.label === 'string' && session.label) ||
    `Session ${session.id}`
  const tool = typeof session.tool === 'string' ? session.tool : null
  const request = typeof session.rootRequestId === 'string' ? session.rootRequestId : null
  const { what, tail } = modelSwitchText(change, tool, request)
  return waitingNotice({
    key: `aico-model:${session.id}:${change.key}`,
    title: `${change.kind === 'paused' ? 'Model refused' : 'Model changed'} in ${name.slice(0, 80)}`,
    body: `It ${change.kind === 'paused' ? '' : 'is '}${what}. ${tail.charAt(0).toUpperCase()}${tail.slice(1)}.`,
    open: `${origin}/?session=${encodeURIComponent(session.id)}`,
    push: 'tray',
  })
}

export class ModelNotices {
  private readonly state: ModelNoticeState
  /** Sessions seen since Tether started (`<host>|<id>`). */
  private readonly seen = new Set<string>()
  /** Launched lanes whose switch line had no receiver: the owner hears it. */
  private readonly unheardLanes = new Set<string>()

  constructor(private readonly deps: ModelNoticeDeps) {
    this.state = deps.state.read()
  }

  private save(): void {
    try {
      this.deps.state.write(this.state)
    } catch {
      // Kept in memory; the next change writes it again.
    }
  }

  /** A session's latest descriptor (local, or relayed with its host). */
  session(session: ModelNoticeSession, host: string | null): void {
    const id = `${host ?? ''}|${session.id}`
    this.seen.add(id)
    const launchedLane =
      session.launched === true &&
      typeof session.coordinatorId === 'string' &&
      !this.unheardLanes.has(session.id)
    const change = launchedLane ? null : modelSwitchOf(session.modelSwitch)
    const sent = this.state.sent[id]
    if (!change) {
      if (sent) this.over(id)
      return
    }
    if (!change.checked || sent?.switchKey === change.key) return
    if (sent) this.deps.resolve(sent.key)
    const notice = modelNotice(session, change, this.deps.origin)
    this.deps.send(notice)
    this.state.sent[id] = { key: notice.key, switchKey: change.key }
    this.save()
  }

  /** The session ended. */
  removed(sessionId: string, host: string | null): void {
    const id = `${host ?? ''}|${sessionId}`
    this.seen.delete(id)
    this.unheardLanes.delete(sessionId)
    if (this.state.sent[id]) this.over(id)
  }

  /** A launched lane's switch line found no receiver: its next descriptor
   * gets the owner's notice instead. */
  unheard(sessionId: string): void {
    this.unheardLanes.add(sessionId)
  }

  /** Once every host has listed its sessions: resolve the notices of
   * sessions that ended while Tether was down or their host went away. */
  sweep(): void {
    for (const id of Object.keys(this.state.sent)) if (!this.seen.has(id)) this.over(id)
  }

  private over(id: string): void {
    const sent = this.state.sent[id]
    if (!sent) return
    this.deps.resolve(sent.key)
    delete this.state.sent[id]
    this.save()
  }
}
