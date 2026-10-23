export function getAgentHubServerUrl(): string | null {
  const configured =
    process.env.AGENT_HUB_URL?.trim() ||
    process.env.NEXT_PUBLIC_AGENT_HUB_URL?.trim() ||
    ''

  return configured || null
}
