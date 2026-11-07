// The one place the hub files meet Tether's config and tool registry. Everything else in
// hub/ takes a HubPorts (daemon.ts passes `tetherHubPorts`); the files default to it only
// so the hub's tests build a Hub with no ports. Moving hub/ out of Tether drops those defaults.

import { DB_FILE_NAME } from '@aico/session-engine/paths'
import { ADAPTERS, adapterOf } from '@aico/session-engine/tui/registry'
import { SIGN_IN_TITLE } from '@aico/session-engine/tui/sign-in-link'
import { API_VERSION, isInstanceName } from '../config'
import type { HubPorts, ToolLogin } from './types'

/** The tools' own logins, from their adapters. */
export const DEFAULT_LOGINS: Record<string, ToolLogin> = Object.fromEntries(
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
