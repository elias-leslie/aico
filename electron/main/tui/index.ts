// Public surface of the TUI layer. Import from here.

export { ensureContext } from './context'
export { launchLine, paneCommand } from './launch'
export {
  defaultTui,
  getTui,
  listTuis,
  registerBuiltinTuis,
} from './registry'
export type { ContextStatus, TuiSpec } from './spec'
