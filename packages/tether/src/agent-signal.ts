// An agent's state as an adapter reports it. A leaf, so the adapter contract and
// the adapters name it without a cycle through the registry; agent-state.ts
// re-exports it.

export const AGENT_STATES = ['working', 'idle', 'blocked', 'unknown'] as const
export type AgentState = (typeof AGENT_STATES)[number]

/** One observation of an agent's own state. `at` is when the agent last
 * changed it, when the agent says; hook holds compare against it. */
export interface AgentSignal {
  state: Exclude<AgentState, 'unknown'>
  source: string
  detail: string | null
  at: number | null
  /** The agent's native conversation ID, to match hook reports. */
  agentSessionId: string | null
}
