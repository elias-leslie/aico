// usage.db: what each subscription has left and when it resets (readings with an as-of
// time), credit lots and plans, daily rows and refusals. collect() reads the providers,
// loadFacts() feeds route() in @aico/context, spendRows() are the Status page's spend card.

export { routeFacts, runUsageCli, USAGE_COMMANDS, type UsageCliIo } from './cli'
export { type Collected, collect } from './collect'
export {
  type Database,
  getState,
  openUsage,
  plansPath,
  putState,
  usageDbPath,
  usageSignature,
} from './db'
export { latestReadings, loadFacts, recordRefusal } from './facts'
export {
  creditFacts,
  currentPlan,
  drawDown,
  type Lot,
  loadPlans,
  localDay,
  type Plan,
  type Plans,
  pacePerDay,
} from './plans'
export { type ReadingEvent, storeReading } from './readings'
export { type UsageReport, usageReport } from './report'
export { type SpendInput, spendRow, spendRows, when } from './spend'
export { type ProjectRef, type ProjectShare, type ProjectSplit, projectSplit } from './split'
export {
  type Credit,
  type Facts,
  micros,
  optionUsage,
  type Reading,
  type Refusal,
  type Usage,
  WINDOW_LABELS,
  type Window,
  windowFacts,
} from './windows'
