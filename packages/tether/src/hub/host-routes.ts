// The host-admin routes: Tether's HTTP surface has one owner, the logic is @aico/fleet's HostAdmin.

import type { HostAdmin } from '@aico/fleet/hub/host-admin'
import { HttpError, type Router, readJsonObject, sendJson } from '@aico/shared/http'

export function registerHostAdminRoutes(router: Router, admin: () => HostAdmin): void {
  router
    .add('GET', '/v1/hosts/:name/logins', async (_req, res, params) => {
      sendJson(res, 200, await admin().status(params.name ?? ''))
    })
    .add('POST', '/v1/hosts/:name/power', async (req, res, params) => {
      const body = await readJsonObject(req)
      if (body.force !== undefined && typeof body.force !== 'boolean')
        throw new HttpError(400, 'invalid_body', { field: 'force' })
      const [status, answer] = await admin().power(params.name ?? '', body.action, !!body.force)
      sendJson(res, status, answer)
    })
    .add('POST', '/v1/hosts/:name/logins/:tool', async (req, res, params) => {
      const body = await readJsonObject(req)
      const [status, answer] = await admin().signInOut(params.name ?? '', params.tool ?? '', body)
      sendJson(res, status, answer)
    })
}
