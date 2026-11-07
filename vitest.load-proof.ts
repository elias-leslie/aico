// Setup for every project, so the gate's verdict and speed do not depend on how busy the machine is.
import { vi } from 'vitest'

// Waits that poll for a condition get a timeout sized for a loaded machine instead of vitest's 1 s.
// A wait that is satisfied returns as soon as it is; only one that never is takes the full time to fail.
const WAIT_MS = 15_000
const waitFor = vi.waitFor.bind(vi)
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === 'object' ? { timeout: WAIT_MS, ...options } : (options ?? WAIT_MS),
  )) as typeof vi.waitFor
