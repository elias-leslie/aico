// Status rows: one per check, job, backup, service, VM, machine, link, grant or
// repo (contracts/status-row.schema.json). aico-web serves them; writers post
// over loopback HTTP or, in aico-web itself, call StatusStore directly.

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
  type Filter,
  PROBLEMS,
  type Rollup,
  SHOWN,
  type Shown,
  type ShownRow,
  SORTS,
  type Sort,
  type StatusView,
  type StoredRow,
  view,
} from './show'
export { machineId, StatusStore, statusDbPath } from './store'
