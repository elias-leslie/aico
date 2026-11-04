// Read-only shapes of /api/context. The browser never imports server packages.
export interface ContextPrompt {
  id: number
  slug: string
  name: string
  content: string
  description: string
  version: number
  updatedAt: string
  contextPolicy: Record<string, unknown> | null
}
export interface ContextRole {
  name: string
  label: string
  description: string
  context: string | null
  updatedAt: string
  prompts: number[]
}
export interface ContextDelivery {
  id: number
  at: string
  tool: string
  role: string | null
  project: string | null
  session: string | null
  tokens: number
  budget: number | null
  observed: boolean
  missing: { id: string; reason: string }[]
  items: {
    id: string
    title: string
    type: string
    tokens: number
    cut: boolean
    use: 'used' | 'unused' | 'unknown'
    observedSessions: number
  }[]
}
export interface ContextView {
  roles: ContextRole[]
  prompts: ContextPrompt[]
  deliveries: ContextDelivery[]
  recentDays: number
  minObservedSessions: number
  bytesPerToken: number
  at: string
}
