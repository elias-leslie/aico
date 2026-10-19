import { HOST_POLICY, policyLocationIn } from './pane-policy'

// A real /etc/tether on the machine running the suite must never change test
// outcomes: point the host policy at a directory that does not exist. Tests of
// the policy itself pass their own tmp location.
Object.assign(
  HOST_POLICY,
  policyLocationIn('/nonexistent/tether-policy', '/nonexistent/tether-run', 0),
)
