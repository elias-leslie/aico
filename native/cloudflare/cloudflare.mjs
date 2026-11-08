// st cloudflare: a small client for Cloudflare's official MCP server (code mode).
// The OAuth grant is the Aico login `cloudflare-mcp-oauth` (JSON), injected as
// CLOUDFLARE_MCP_OAUTH by st-cloudflare. Tokens are never printed or logged.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LOGIN_NAME = 'cloudflare-mcp-oauth'
const DEFAULT_MCP_URL = 'https://mcp.cloudflare.com/mcp'
// Narrow grant: DNS records, Access apps/policies, Tunnels. Cloudflare asks for more on demand.
export const DEFAULT_SCOPES =
  'offline_access user:read account:read zone.read dns.read dns.write access-app.read access-app.write access-policy.read access-policy.write access-group.read argotunnel.read argotunnel.write'

const mcpUrl = () => process.env.CLOUDFLARE_MCP_URL || DEFAULT_MCP_URL
const origin = () => new URL(mcpUrl()).origin
const pendingFile = () =>
  join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'st-cloudflare-login.json')

const b64url = (buf) => Buffer.from(buf).toString('base64url')
export const challengeFor = (verifier) => b64url(createHash('sha256').update(verifier).digest())

/** Parse a Streamable HTTP reply (JSON or SSE) and return the JSON-RPC message for `id`. */
export function parseRpc(text, contentType, id) {
  if (!String(contentType).includes('text/event-stream')) return JSON.parse(text)
  let found
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    const msg = JSON.parse(data)
    if (msg.id === id) found = msg
  }
  if (!found) throw new Error('No reply for the request in the event stream')
  return found
}

const q = (value) => JSON.stringify(value)

/** JavaScript for the server's `execute` tool: one API request, optionally reshaped server side. */
export function requestCode({ method = 'GET', path, body, project }) {
  const req = `{ method: ${q(method)}, path: ${q(path)}${body === undefined ? '' : `, body: ${q(body)}`} }`
  return `async () => { const r = await cloudflare.request(${req}); ${project ? `return (${project})(r);` : 'return r;'} }`
}

export const projections = {
  tunnels: `(r) => ({ success: r.success, tunnels: (r.result || []).map((t) => ({ id: t.id, name: t.name, status: t.status, type: t.tun_type, created: t.created_at, connections: (t.connections || []).length, deleted: t.deleted_at || undefined })), errors: r.errors })`,
  apps: `(r) => ({ success: r.success, apps: (r.result || []).map((a) => ({ id: a.id, name: a.name, domain: a.domain, type: a.type, session: a.session_duration, policies: (a.policies || []).map((p) => ({ id: p.id, name: p.name, decision: p.decision })) })), errors: r.errors })`,
  policies: `(r) => ({ success: r.success, policies: (r.result || []).map((p) => ({ id: p.id, name: p.name, decision: p.decision, include: p.include, exclude: p.exclude, require: p.require, apps: p.app_count })), errors: r.errors })`,
  zones: `(r) => ({ success: r.success, zones: (r.result || []).map((z) => ({ id: z.id, name: z.name, status: z.status })), errors: r.errors })`,
  dns: `(r) => ({ success: r.success, total: r.result_info && r.result_info.total_count, records: (r.result || []).map((d) => ({ id: d.id, type: d.type, name: d.name, content: d.content, proxied: d.proxied, ttl: d.ttl })), errors: r.errors })`,
}

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s)
      if (inline !== undefined) out.flags[k] = inline
      else if (['raw', 'help', 'no-truncate'].includes(k)) out.flags[k] = true
      else out.flags[k] = argv[++i]
    } else out._.push(a)
  }
  return out
}

// ---- login storage -------------------------------------------------------------------------

function loadGrant() {
  const raw = process.env.CLOUDFLARE_MCP_OAUTH
  if (!raw) throw new Error('Not signed in. Run: st cloudflare login')
  return JSON.parse(raw)
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))))
    child.stdin.end(input)
  })
}

async function saveGrant(grant, exists) {
  const aico = process.env.AICO_BIN || 'aico'
  const args = exists
    ? ['logins', 'rotate', LOGIN_NAME]
    : ['logins', 'set', LOGIN_NAME, '--kind', 'tool login', '--notes', 'Cloudflare MCP OAuth grant for st cloudflare']
  await run(aico, args, JSON.stringify(grant))
}

// ---- OAuth ---------------------------------------------------------------------------------

async function json(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}: ${data.error_description || data.error || 'failed'}`)
  return data
}

const metadata = () => json(`${origin()}/.well-known/oauth-authorization-server`)

async function tokenRequest(meta, params) {
  return json(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  })
}

function grantFrom(tokens, previous) {
  return {
    ...previous,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || previous.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope || previous.scope,
  }
}

async function exchange(pending, code) {
  const meta = await metadata()
  const tokens = await tokenRequest(meta, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirect_uri,
    client_id: pending.client_id,
    code_verifier: pending.verifier,
    resource: mcpUrl(),
  })
  const grant = grantFrom(tokens, {
    client_id: pending.client_id,
    account_id: pending.account_id,
    scope: pending.scope,
  })
  const exists = await run(process.env.AICO_BIN || 'aico', ['logins', 'show', LOGIN_NAME], '').then(
    () => true,
    () => false,
  )
  await saveGrant(grant, exists)
  rmSync(pendingFile(), { force: true })
  return grant
}

function codeFromUrl(pending, urlText) {
  const url = new URL(urlText)
  if (url.searchParams.get('state') !== pending.state) throw new Error('State mismatch')
  const err = url.searchParams.get('error')
  if (err) throw new Error(`Cloudflare refused: ${err} ${url.searchParams.get('error_description') || ''}`)
  const code = url.searchParams.get('code')
  if (!code) throw new Error('No authorization code in the URL')
  return code
}

async function login(flags) {
  const meta = await metadata()
  const scope = flags.scopes || DEFAULT_SCOPES
  const verifier = b64url(randomBytes(48))
  const state = b64url(randomBytes(16))
  let finish
  const done = new Promise((resolve, reject) => {
    finish = { resolve, reject }
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('Cloudflare is connected to Aico. You can close this tab.')
    finish.resolve(`http://127.0.0.1${req.url}`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const redirect_uri = `http://127.0.0.1:${server.address().port}/callback`
  const reg = await json(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Aico st cloudflare',
      redirect_uris: [redirect_uri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  })
  const pending = { client_id: reg.client_id, redirect_uri, verifier, state, scope, account_id: flags.account }
  writeFileSync(pendingFile(), JSON.stringify(pending), { mode: 0o600 })
  chmodSync(pendingFile(), 0o600)
  const auth = new URL(meta.authorization_endpoint)
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri,
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
    state,
    scope,
    resource: mcpUrl(),
  }))
    auth.searchParams.set(k, v)
  process.stdout.write(`Open this URL in your browser and approve:\n${auth}\n\nWaiting for the approval (Ctrl-C to stop)...\n`)
  const timer = setTimeout(() => finish.reject(new Error('No approval within 60 minutes')), 3600_000)
  try {
    const url = await done
    await exchange(pending, codeFromUrl(pending, url))
    process.stdout.write(`Signed in. Grant saved as the Aico login ${LOGIN_NAME}.\n`)
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

async function finishLogin(urlText) {
  if (!urlText) throw new Error('Usage: st cloudflare finish <callback-url>')
  if (!existsSync(pendingFile())) throw new Error('No login in progress. Run: st cloudflare login')
  const pending = JSON.parse(readFileSync(pendingFile(), 'utf8'))
  await exchange(pending, codeFromUrl(pending, urlText))
  process.stdout.write(`Signed in. Grant saved as the Aico login ${LOGIN_NAME}.\n`)
}

// ---- MCP client ----------------------------------------------------------------------------

async function accessToken(state) {
  const grant = state.grant
  if (grant.access_token && grant.expires_at - Date.now() > 60_000 && !state.forceRefresh) return grant.access_token
  if (!grant.refresh_token) throw new Error('The grant expired. Run: st cloudflare login')
  const meta = await metadata()
  const tokens = await tokenRequest(meta, {
    grant_type: 'refresh_token',
    refresh_token: grant.refresh_token,
    client_id: grant.client_id,
    resource: mcpUrl(),
  }).catch((e) => {
    throw new Error(`${e.message}. Run: st cloudflare login`)
  })
  state.grant = grantFrom(tokens, grant)
  state.forceRefresh = false
  await saveGrant(state.grant, true).catch(() => {
    process.stderr.write('Warning: could not save the refreshed grant.\n')
  })
  return state.grant.access_token
}

async function rpc(state, method, params, id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${await accessToken(state)}`,
    }
    if (state.session) headers['mcp-session-id'] = state.session
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
    })
    if (res.status === 401 && attempt === 0) {
      state.forceRefresh = true
      continue
    }
    const text = await res.text()
    if (res.status === 403) {
      const hint = res.headers.get('www-authenticate') || ''
      throw new Error(`Cloudflare says the grant lacks a permission. ${hint.match(/scope="([^"]*)"/)?.[0] ?? ''} Run: st cloudflare login --scopes "<current scopes + the missing one>"`)
    }
    if (!res.ok) throw new Error(`MCP ${res.status}: ${text.slice(0, 300)}`)
    if (id === undefined) return undefined
    state.session = res.headers.get('mcp-session-id') || state.session
    const msg = parseRpc(text, res.headers.get('content-type'), id)
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
    return msg.result
  }
  throw new Error('Cloudflare refused the grant. Run: st cloudflare login')
}

async function connect() {
  const state = { grant: loadGrant() }
  await rpc(state, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'st-cloudflare', version: '1' },
  }, 1)
  await rpc(state, 'notifications/initialized', {})
  return state
}

const textOf = (result) => (result.content || []).map((c) => c.text ?? '').join('\n')

async function callTool(state, name, args) {
  const result = await rpc(state, 'tools/call', { name, arguments: args }, 2)
  if (result.isError) throw new Error(textOf(result) || 'Tool error')
  return result
}

async function api(state, flags, request) {
  const account = flags.account || state.grant.account_id
  const args = { code: requestCode(request), truncate: false }
  if (account) args.account_id = account
  const out = textOf(await callTool(state, 'execute', args))
  try {
    return flags.raw ? out : JSON.stringify(JSON.parse(out), null, 2)
  } catch {
    return out
  }
}

function accountOr(state, flags) {
  const account = flags.account || state.grant.account_id
  if (!account) throw new Error('No account. Pass --account ID, or sign in with: st cloudflare login --account ID')
  return account
}

async function zoneId(state, flags, name) {
  const found = JSON.parse(
    await api(state, { ...flags, raw: true }, { path: `/zones?name=${encodeURIComponent(name)}`, project: projections.zones }),
  )
  const zone = found.zones?.[0]
  if (!zone) throw new Error(`No zone named ${name} visible to this grant`)
  return zone.id
}

const HELP = `Usage: st cloudflare <command>
  login [--account ID] [--scopes "A B"]  one-time OAuth in your browser; saves the Aico login ${LOGIN_NAME}
  finish URL                             complete a login from the callback URL if the browser could not reach this host
  status                                 who the grant is, scopes, expiry (no secrets)
  tunnels [--account ID]                 list Cloudflare Tunnels (read-only)
  access-apps [--account ID]             list Access apps and their policies (read-only)
  access-policies [--account ID]         list reusable Access policies (read-only)
  zones                                  list zones
  dns [--zone summitflow.dev] [--type A] [--name host]   list DNS records (read-only)
  api METHOD PATH [--json BODY]          any Cloudflare API call, e.g. api GET /accounts/ID/cfd_tunnel
  tools                                  the server's tools (docs, search, execute, whoami)
  call TOOL --json '{"code":"..."}'      raw MCP tool call (search spec.paths, then execute)
Options: --raw for compact JSON. Writes go through api/call and are limited to the granted scopes.`

async function main(argv) {
  const { _: [cmd, ...rest], flags } = parseArgs(argv)
  if (!cmd || cmd === 'help' || flags.help) return process.stdout.write(`${HELP}\n`)
  if (cmd === 'login') return login(flags)
  if (cmd === 'finish') return finishLogin(rest[0])
  const state = await connect()
  const print = (s) => process.stdout.write(`${s}\n`)
  if (cmd === 'tools') {
    const { tools } = await rpc(state, 'tools/list', {}, 3)
    return print(tools.map((t) => `${t.name}: ${String(t.description).split('\n')[0]}`).join('\n'))
  }
  if (cmd === 'status') {
    const g = state.grant
    const who = textOf(await callTool(state, 'whoami', {}))
    return print(`${who}\nscopes: ${g.scope}\naccount: ${g.account_id || '(not set)'}\naccess token expires: ${new Date(g.expires_at).toISOString()}`)
  }
  if (cmd === 'call') {
    if (!rest[0]) throw new Error('Usage: st cloudflare call TOOL --json ARGS')
    return print(textOf(await callTool(state, rest[0], flags.json ? JSON.parse(flags.json) : {})))
  }
  if (cmd === 'api') {
    const [method, path] = rest
    if (!method || !path) throw new Error('Usage: st cloudflare api METHOD PATH [--json BODY]')
    return print(await api(state, flags, { method: method.toUpperCase(), path, body: flags.json ? JSON.parse(flags.json) : undefined }))
  }
  if (cmd === 'tunnels')
    return print(await api(state, flags, { path: `/accounts/${accountOr(state, flags)}/cfd_tunnel?is_deleted=false&per_page=100`, project: projections.tunnels }))
  if (cmd === 'access-apps')
    return print(await api(state, flags, { path: `/accounts/${accountOr(state, flags)}/access/apps?per_page=100`, project: projections.apps }))
  if (cmd === 'access-policies')
    return print(await api(state, flags, { path: `/accounts/${accountOr(state, flags)}/access/policies?per_page=100`, project: projections.policies }))
  if (cmd === 'zones')
    return print(await api(state, flags, { path: `/zones?per_page=50${state.grant.account_id || flags.account ? `&account.id=${accountOr(state, flags)}` : ''}`, project: projections.zones }))
  if (cmd === 'dns') {
    const id = await zoneId(state, flags, flags.zone || 'summitflow.dev')
    const query = new URLSearchParams({ per_page: '500' })
    if (flags.type) query.set('type', flags.type)
    if (flags.name) query.set('name', flags.name)
    return print(await api(state, flags, { path: `/zones/${id}/dns_records?${query}`, project: projections.dns }))
  }
  throw new Error(`Unknown command: ${cmd}\n${HELP}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`st cloudflare: ${e.message}\n`)
      process.exit(1)
    },
  )
}
