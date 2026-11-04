import { apiFetch } from './api-fetch'
export interface ChatSummary {
  id: string
  title: string
  role: string
  cwd: string
  state: string
  updatedAt: number
  startedAt: number
  model: string | null
  nextModel: string | null
  firstModel: string | null
  last: string
}
export interface ChatMessage {
  seq: number
  role: string
  model: string | null
  turn: number
  at: string
  stop_reason: string | null
  content: unknown
  meta: Record<string, unknown>
  outcome: Record<string, unknown> | null
  input: number | null
  cache_read: number | null
  cache_write: number | null
  output: number | null
}
export interface ChatQuestion {
  id: string
  question: string
  options: string[]
  recommended: number | null
  body: string | null
}
export interface ChatView extends ChatSummary {
  questionsStatus?: 'loading' | 'ready' | 'stale' | 'failed'
  draft: string
  draftAttachments?: string[]
  queued: string[]
  note: string | null
  effort: string | null
  partial: { text: string; model: string; turn: number } | null
  parent: string | null
  branchTurn: number | null
  questions?: ChatQuestion[]
  messages: ChatMessage[]
  chain: { id: string; effort: string | null }[]
  handoffs: {
    seq: number
    at: string
    from_model: string
    to_model: string
    reason: string
  }[]
  tools: {
    seq: number
    name: string
    started_at: string
    ended_at: string | null
  }[]
  totals: {
    startedAt: number
    tokens: {
      input: number
      cacheRead: number
      cacheWrite: number
      output: number
    }
    toolCalls: number
  }
  outcome: Record<string, unknown> | null
}
export interface ChatOptions {
  defaultRole: string
  roles: {
    role: string
    description: string
    chain: { id: string; effort: string | null; reason: string }[]
    error: string | null
  }[]
  projects: { id: string; name: string; root: string | null }[]
}
export const chatCall = <T = ChatView>(path: string, body: unknown = {}) =>
  apiFetch<T>(`/api/chat${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const chatText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('')
      : ''
export const CHAT_STATE: Record<string, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped mid-reply',
  failed: 'No model answered',
  ended: 'Ended',
  swapped: 'Stopped by a model swap',
}
export const newChat = () => window.dispatchEvent(new Event('aico:new-chat'))
