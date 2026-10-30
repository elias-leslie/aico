import type { NightshiftOwnerView } from '../lib/health'

/** A fresh, all-good Nightshift owner view; tests override what they need. */
export const view = (
  over: Partial<NightshiftOwnerView> = {},
): NightshiftOwnerView => ({
  version: 1,
  snapshot: { state: 'fresh', age: 120 },
  verdict: { state: 'ok', label: 'All good', reason: '', doing: '' },
  tiles: [],
  findings: [],
  needs_you: 0,
  approvals: [],
  links: {
    status: 'https://ns.example/',
    needs_you: 'https://ns.example/#needs-you',
    notices: 'https://ns.example/n',
  },
  ...over,
})
