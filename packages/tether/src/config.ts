/** Tether's own API contract version. Clients declare the minimum they need.
 * 2: resize claims carry a viewer label (still accepted without one).
 * 3: session wakes; End takes `keepWakes`.
 * 4: shares link files where they are (`paths`); GET /v1/shares lists them.
 * 5, 6: chat routes and a chat `inject` model (retired with the Agent Hub chat backend).
 * 9: `parentId` on descriptors; root `lineage` takes `parentId`.
 * 10: `host: "auto"` with `needs` on `POST /v1/roots`; `GET /v1/placement`.
 * 12: lane reports: descriptors carry `stateAgentAt`, `waitingOn` and `launched`;
 *     `/v1/sessions/:id/watches`; wake lists show check-ins only.
 * 13: general waits (`/v1/waits`, `/v1/sessions/:id/waits`); `inject` takes
 *     `from`; End answers `keptWaits`.
 * 14: placement `room: "local"` hosts; `needs` with a named `host`.
 * 15: `entry` on `POST /v1/roots` (per-session entries.json program).
 * 16: deliveries (`POST /v1/sessions/:id/deliveries`, `GET /v1/deliveries/:id`,
 *     `GET /v1/sessions/:id/due`).
 * 17: wait kinds job, reply, run, ask, host and tap; `POST /v1/waits/check`
 *     (nudge); asks carry `answerTo`.
 * 18: wait kind `cmd` (`argv`, `cwd`); `DELETE /v1/sessions/:id/deliveries?source=`
 *     (withdraw); agy sessions take event lines.
 * 19: `entry` runs `codex` roots too (state from the entry home's rollouts).
 * 20: `entry` runs `pi` roots too (the conversation id Tether chose, read from
 *     the entry home's Pi session file).
 * 21: `endedBy` on `POST /v1/sessions/:id/end` (that session gets no lane
 *     `ended` line for it).
 * 22: `modelSwitch` on the session descriptor; `POST /v1/sessions/:id/rewind`.
 * 23: the hub takes a forwarded End's asker in the `Tether-Ended-By` header
 *     (a session on another host: no lane `ended` line for it).
 * 24: delivery classes: `ride` and `from` on `POST /v1/sessions/:id/deliveries`,
 *     `GET /v1/sessions/:id/due?ride=1`.
 * 25: `reply` on `POST /v1/sessions/:id/deliveries`; `GET /v1/sessions/:id/due?ride=peek`
 *     and `DELETE /v1/sessions/:id/due?token=` (take ride-along lines once shown).
 * 26: asks that want files: `files` on `POST /v1/asks`, `files` on an answer,
 *     `wantsFiles` and `files` on the ask (schema 30).
 * 27: `GET /v1/history`, `/v1/history/:id`, `/v1/history/:id/events` (schema 31).
 * 31: `open` and `origin` on `POST /v1/asks` and on the ask: the https link it opens, and who
 *     filed it when an app did (schema 35).
 * 32: `attach` on `POST /v1/asks` (paths linked as a share), `attached` on the ask: those
 *     files as they are on disk now.
 *
 * A bump also changes EXPECTED_TETHER_API_VERSION in packages/tether-client (config.test.ts keeps
 * them equal): a deploy restarts Tether when its code changed, and the web server names a daemon
 * older than that. */
export const API_VERSION = 32

/** Where Aico's web server listens on this host (`AICO_WEB_URL` overrides it). */
export const AICO_WEB_DEFAULT_URL = 'http://127.0.0.1:3002'

export interface ShowConfig {
  /** Shares older than this are dropped when the next one arrives. */
  retentionDays: number
}

export function resolveShowConfig(env: NodeJS.ProcessEnv = process.env): ShowConfig {
  const raw = env.TETHER_SHARE_RETENTION_DAYS
  const retentionDays = raw === undefined ? 30 : Number(raw)
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !(retentionDays >= 1)) {
    throw new Error('TETHER_SHARE_RETENTION_DAYS must be a whole number of days, at least 1')
  }
  return { retentionDays }
}

// Paths and the entry-scan limits live in the session engine; Tether code keeps importing them from here.
export * from '@aico/session-engine/entry-scan'
export * from '@aico/session-engine/paths'
