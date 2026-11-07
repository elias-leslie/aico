'use client'

import { StatusPage } from '../status/StatusPage'

/** Wide's second column at home. Part 2 of the redesign fills it with the
 * overview (Status ranked by consequence, Today, Projects, Recent, Quota and
 * spend); until then it shows Status, the page that overview leads with. */
export function WideOverview() {
  return <StatusPage />
}
