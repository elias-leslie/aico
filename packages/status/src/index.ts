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
} from './intent'
export { drainOutbox, type OutboxOptions, outboxDir, postOrKeep } from './outbox'
export {
  ACTION_KINDS,
  type Action,
  type ActionKind,
  KINDS,
  type Kind,
  parseRow,
  RowError,
  STATES,
  type State,
  type StatusRow,
} from './row'
export {
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
  summary,
  type UnknownWhy,
  view,
} from './show'
export { machineId, StatusStore, statusDbPath } from './store'
