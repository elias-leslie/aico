import { NextResponse } from 'next/server'
import { getAgentHubServerUrl } from './agent-hub'

export const AGENT_HUB_PROXY_PASSTHROUGH_HEADERS = [
  'content-type',
  'x-source-client',
  'x-source-path',
] as const

function getSafeAgentHubErrorDetail(status: number): string {
  if (status === 400 || status === 422) {
    return 'Agent Hub rejected the request'
  }

  if (status === 401 || status === 403) {
    return 'Agent Hub denied the request'
  }

  if (status === 404) {
    return 'Agent Hub endpoint is unavailable'
  }

  if (status >= 500) {
    return 'Agent Hub is temporarily unavailable'
  }

  return 'Agent Hub request failed'
}

export async function proxyAgentHubRequest({
  method,
  path,
  body,
  headers,
}: {
  method: 'GET' | 'POST'
  path: '/api/models' | '/api/complete'
  body?: string
  headers?: HeadersInit
}): Promise<NextResponse> {
  const agentHubUrl = getAgentHubServerUrl()
  if (!agentHubUrl) {
    return NextResponse.json(
      { detail: 'Agent Hub is not configured' },
      { status: 503 },
    )
  }

  try {
    const upstream = await fetch(`${agentHubUrl}${path}`, {
      method,
      headers,
      body,
      cache: 'no-store',
    })

    if (!upstream.ok) {
      console.error('Agent Hub proxy upstream returned error', {
        path,
        status: upstream.status,
      })

      return NextResponse.json(
        { detail: getSafeAgentHubErrorDetail(upstream.status) },
        { status: upstream.status },
      )
    }

    const responseBody = await upstream.text()

    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (error) {
    console.error('Agent Hub proxy request failed', {
      path,
      error,
    })

    return NextResponse.json(
      { detail: 'Failed to reach Agent Hub' },
      { status: 502 },
    )
  }
}
