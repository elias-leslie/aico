// The one place the hub (@aico/fleet/hub/*) meets Tether's config and tool registry: the
// daemon, the server and the CLI pass `tetherHubPorts` in.

import type { FleetCliPorts } from '@aico/fleet/hub/fleet-cli'
import type { HubPorts } from '@aico/fleet/hub/types'
import { DB_FILE_NAME, isInstanceName, type TetherPaths } from '@aico/session-engine/paths'
import { ADAPTERS, adapterOf } from '@aico/session-engine/tui/registry'
import { SIGN_IN_TITLE } from '@aico/session-engine/tui/sign-in-link'
import type { ToolLogin } from '@aico/shared/tool-login'
import { callSocket } from '../client'
import { API_VERSION } from '../config'

/** The tools' own logins, from their adapters. */
const DEFAULT_LOGINS: Record<string, ToolLogin> = Object.fromEntries(
  ADAPTERS.map((adapter) => [adapter.id, adapter.login]),
)

export const tetherHubPorts: HubPorts = {
  apiVersion: API_VERSION,
  isInstanceName,
  dbFile: DB_FILE_NAME,
  tools: {
    logins: DEFAULT_LOGINS,
    signInTitle: SIGN_IN_TITLE,
    entryApiVersion: (tool) => adapterOf(tool)?.entryApiVersion ?? undefined,
    entryTools: () =>
      ADAPTERS.flatMap((adapter) =>
        adapter.entryApiVersion
          ? [{ id: adapter.id, entryApiVersion: adapter.entryApiVersion }]
          : [],
      ),
  },
}

/** `tether fleet`: the hub's ports plus a request to this Tether's own control socket. */
export function fleetCliPorts(paths: Pick<TetherPaths, 'socket'>): FleetCliPorts {
  return {
    ...tetherHubPorts,
    callSocket: (method, path, body) => callSocket(paths.socket, method, path, body),
  }
}
