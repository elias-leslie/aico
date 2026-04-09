export function createCspNonce(): string {
  return crypto.randomUUID()
}

export function buildContentSecurityPolicy({
  nonce,
  isDevelopment = process.env.NODE_ENV === 'development',
}: {
  nonce: string
  isDevelopment?: boolean
}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    isDevelopment ? "'unsafe-eval'" : '',
  ].filter(Boolean).join(' ')

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' http: https: ws: wss:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')
}
