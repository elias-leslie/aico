import { PORTS } from '../api-config'

export function createCspNonce(): string {
  return crypto.randomUUID()
}

function toUrlOrNull(value: string | undefined): URL | null {
  if (!value) {
    return null
  }

  try {
    return new URL(value)
  } catch {
    return null
  }
}

function toWebSocketOrigin(url: URL): string {
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${url.host}`
}

function buildConnectSrc({
  isDevelopment,
  requestUrl,
}: {
  isDevelopment: boolean
  requestUrl?: string
}): string {
  const sources = new Set<string>(["'self'"])
  const request = toUrlOrNull(requestUrl)
  const configuredAgentHubUrl = toUrlOrNull(
    process.env.NEXT_PUBLIC_AGENT_HUB_URL?.trim(),
  )

  if (
    request &&
    isDevelopment &&
    (request.hostname === 'localhost' || request.hostname === '127.0.0.1')
  ) {
    sources.add(`ws://${request.host}`)
  }

  if (request) {
    sources.add(
      `${request.protocol === 'https:' ? 'wss:' : 'ws:'}//${request.hostname}:${PORTS.agentHub}`,
    )
  }

  if (configuredAgentHubUrl) {
    sources.add(configuredAgentHubUrl.origin)
    sources.add(toWebSocketOrigin(configuredAgentHubUrl))
  }

  return Array.from(sources).join(' ')
}

export function buildContentSecurityPolicy({
  nonce,
  isDevelopment = process.env.NODE_ENV === 'development',
  requestUrl,
}: {
  nonce: string
  isDevelopment?: boolean
  requestUrl?: string
}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    isDevelopment ? "'unsafe-eval'" : '',
  ]
    .filter(Boolean)
    .join(' ')
  const connectSrc = buildConnectSrc({ isDevelopment, requestUrl })

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')
}
