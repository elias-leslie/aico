// Workflow runs for the web app: the runs Tether follows for the sessions
// here. Tether owns the runs and holds the Agent Hub credentials; this route
// only passes its answer on. Decisions on a run go through the session that
// launched it.

import type { TetherClient } from 'tether/client'
import type { Router } from './http'
import { tetherCall } from './lifecycle'

export function registerRunRoutes(router: Router, tether: TetherClient) {
  // The runs and steps to show, with whether Agent Hub could be read.
  router.on('GET', '/api/runs', () => tetherCall(() => tether.runs()))
}
