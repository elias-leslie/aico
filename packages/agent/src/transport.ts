// The same endpoint check serves agent runs and ask. A native CLI has no
// verifiable endpoint, so only a role with unrestricted egress may use it.
export interface Egress {
  egress: string
  hosts: string[] | null
}

export function transportHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return baseUrl
  }
}

export function transportRefusal(
  egress: Egress,
  model: string,
  baseUrl?: string,
): { kind: 'refused'; reason: 'egress_denied'; detail: string } | null {
  if (egress.hosts === null) return null
  const host = baseUrl === undefined ? null : transportHost(baseUrl)
  if (host !== null && egress.hosts.includes(host)) return null
  return {
    kind: 'refused',
    reason: 'egress_denied',
    detail: `egress profile '${egress.egress}' allows ${egress.hosts.join(', ')}; ${model} ${host === null ? 'uses a native CLI with no verifiable model endpoint' : `at ${host} is outside that profile`}`,
  }
}
