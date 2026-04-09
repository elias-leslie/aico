export type AgentState =
  | 'not_started'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error'

export interface AgentStateCarrier {
  agent_state?: AgentState | null
  claude_state?: AgentState | null
}

export function getAgentState(
  value: AgentStateCarrier | null | undefined,
): AgentState | undefined {
  return value?.agent_state ?? value?.claude_state ?? undefined
}
