// Public surface of the TUI layer. Import from here.

export { ensureContext } from './context'
export { effectiveTuiPath, launchLine, paneCommand, paneGatePath } from './launch'
export {
  defaultTui,
  getTui,
  listTuis,
  registerBuiltinTuis,
} from './registry'
export type { ContextStatus, TuiSpec } from './spec'
