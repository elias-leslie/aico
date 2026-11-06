// context.db: memories, prompts, roles with their launch rows, context budgets,
// project permissions and the models the launch policy names; route() answers
// `models route`; deliver() builds each session's context.

export { routeFacts } from '@aico/usage'
export { CONTEXT_COMMANDS, type ContextCliIo, runContextCli } from './cli'
export {
  bindContextSession,
  budgetHint,
  COST,
  type CostDelivery,
  estimatedTokens,
  type InventoryItem,
  observeDelivery,
  recentDeliveries,
  recordContextFill,
  tokenBudget,
  type UseEvent,
  unusedItems,
} from './cost'
export { contextDbPath, type Database, openContext } from './db'
export {
  type Activity,
  DELIVERY,
  type DeliverRequest,
  type Delivery,
  deliver,
  deliveryTools,
  readToolUsage,
  recordDelivery,
  type Section,
  type Source,
  setDeliveryTool,
  toolId,
} from './deliver'
export { ContextEditError, contextCatalog, editPrompt, editRole } from './editor'
export { type LaunchPolicy, loadPolicy } from './launch'
export {
  addMemory,
  deleteMemory,
  type Found,
  getMemories,
  listMemories,
  type Memory,
  searchMemories,
} from './memory'
export { Catalog, MODELS, type Model } from './models'
export { getPrompt, listPrompts, type Prompt } from './prompts'
export { type Facts, modelUsage, type RoutePayload, route, type Usage } from './route'
