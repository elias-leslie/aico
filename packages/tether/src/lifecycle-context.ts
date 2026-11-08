// The slice of the shared daemon context that reboot, recovery and the wake
// runtime read. A type file: they take it without importing lifecycle-api, which
// imports them (its LifecycleApiContext has every field here, and more).

import type { Placement } from '@aico/fleet/hub/placement'
import type { EventBus } from '@aico/session-engine/events'
import type { Store } from '@aico/session-engine/store'
import type { TetherPaths } from './config'
import type { LaneReporter } from './lane-reports'
import type { WaitService } from './waits'

export interface LifecycleContext {
  paths: TetherPaths
  store: Store
  events: EventBus
  /** `host: "auto"` placement; absent in route-only tests. */
  placement?: Placement
  /** Lane reports; absent where Tether does not observe sessions. */
  lanes?: LaneReporter
  /** General waits (src/waits.ts); absent where Tether does not observe sessions. */
  waits?: WaitService
}
