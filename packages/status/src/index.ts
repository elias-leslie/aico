// Status rows: one per check, job, backup, service, VM, machine, link, grant or
// repo (contracts/status-row.schema.json). aico-web serves them; writers post
// over loopback HTTP or, in aico-web itself, call StatusStore directly.

export {
  type AlertBatch,
  type AlertChange,
  type AlertHook,
  alerting,
  alertText,
  transitions,
} from './alerts'
export {
  expectedOffSince,
  expectedState,
  INTENTS,
  type Intent,
  type MachineIntent,
  showsBack,
} from './intent'
export { type Major, type MajorWindows, majorOf, needsOwner } from './major'
export { drainOutbox, type OutboxOptions, outboxDir, postOrKeep } from './outbox'
export {
  ACTION_KINDS,
  type Action,
  type ActionKind,
  GUARD_PHASES,
  jobEnv,
  jobSchedule,
  KINDS,
  type Kind,
  LIMITS,
  parseRow,
  RowError,
  STATES,
  type State,
  type StatusRow,
  type ThermalGuard,
} from './row'
export { deleteStatusRow, postStatusRows, type RowsRequest, statusRowsUrl } from './rows-api'
export {
  type Concentration,
  CROWD_MIN,
  concentration,
  counted,
  type Filter,
  PROBLEMS,
  type Problem,
  type Rollup,
  SHOWN,
  type Shown,
  type ShownRow,
  SORTS,
  type Sort,
  type StatusView,
  type StoredRow,
  type Summary,
  type Sustained,
  summary,
  type UnknownWhy,
  view,
} from './show'
export { machineId, StatusStore, type SustainedHook, statusDbPath } from './store'
