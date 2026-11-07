// The Quota page: what each subscription has left and what was spent per day.
//
//   GET /api/usage   per provider: windows with their reset, credits and days left, spend per
//                    day for the last 14 days (credits or tokens, whichever the provider has),
//                    and when usage was last collected. 503 when nothing was collected yet or
//                    usage.db cannot be read; the page says so.
import { usageReport } from '@aico/usage'
import type { Router } from './http'
import { HttpError } from './tether'

export interface UsageRouteDeps {
  dataDir: string
  now?: () => Date
}

export function registerUsageRoutes(router: Router, deps: UsageRouteDeps): void {
  router.on('GET', '/api/usage', () => {
    const report = usageReport(deps.dataDir, (deps.now?.() ?? new Date()).toISOString())
    if ('error' in report) throw new HttpError(503, report.error)
    return report
  })
}
