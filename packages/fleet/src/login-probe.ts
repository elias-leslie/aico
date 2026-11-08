// Checks a login page before it is saved: fetch it (no browser, no cookies), follow its redirects and
// look for a password field. A site root that sends you to a portal gets a warning and, when one of the
// page's sign-in links or a usual login path has a password field, that URL as the one to save instead.
import { loginPage, loginPolicy } from './logins'

export interface LoginProbe {
  /** Where the page ended up after its redirects. */
  finalUrl: string | null
  /** A password field is in the page's HTML. */
  password: boolean
  /** A URL on the same site that does have one, when the saved one does not. */
  suggestion: string | null
  /** One plain line for the owner or agent; empty when the page looks right. */
  warning: string
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

const PASSWORD = /<input\b[^>]*\btype\s*=\s*["']?password\b/i
const LINK = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi
const SIGN_IN = /log\s*-?\s*in|sign\s*-?\s*in/i

async function page(
  url: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<{ url: string; html: string } | null> {
  if (signal.aborted) return null
  try {
    const response = await fetcher(url, {
      redirect: 'follow',
      signal,
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Aico login page check)' },
    })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    while (size < loginPolicy.probeMaxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
    void reader.cancel().catch(() => {})
    return { url: response.url || url, html: Buffer.concat(chunks).toString('utf8') }
  } catch {
    return null
  }
}

/** The page's own sign-in links on its site, then the usual login paths, each once. */
function candidates(start: URL, landed: { url: string; html: string } | null): string[] {
  const out = new Set<string>()
  const origins = new Set([start.origin, ...(landed ? [new URL(landed.url).origin] : [])])
  if (landed)
    for (const [, href, text] of landed.html.matchAll(LINK)) {
      if (!SIGN_IN.test(`${href} ${text.replace(/<[^>]*>/g, ' ')}`)) continue
      try {
        const url = new URL(href.replace(/&amp;/g, '&'), landed.url)
        if (origins.has(url.origin)) out.add(url.href)
      } catch {
        /* not a link we can follow */
      }
    }
  for (const path of loginPolicy.probePaths) out.add(new URL(path, start.origin).href)
  out.delete(start.href)
  // The saved page's own site first: another site's form wants that site's password.
  return [...out]
    .sort(
      (a, b) =>
        Number(new URL(a).origin !== start.origin) - Number(new URL(b).origin !== start.origin),
    )
    .slice(0, loginPolicy.probeMaxTries)
}

export async function probeLoginPage(
  value: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<LoginProbe> {
  let start: URL
  try {
    start = new URL(loginPage(value))
  } catch (error) {
    return {
      finalUrl: null,
      password: false,
      suggestion: null,
      warning: error instanceof Error ? error.message : 'That login page is not a web address.',
    }
  }
  // One deadline for the whole check, so a save never waits longer than probeSeconds on it.
  const signal = AbortSignal.timeout(loginPolicy.probeSeconds * 1000)
  const landed = await page(start.href, fetcher, signal)
  if (landed && PASSWORD.test(landed.html))
    return { finalUrl: landed.url, password: true, suggestion: null, warning: '' }
  for (const url of candidates(start, landed)) {
    const found = await page(url, fetcher, signal)
    // Only a page on the saved site: the saved password goes nowhere else.
    if (found && new URL(found.url).origin === start.origin && PASSWORD.test(found.html))
      return {
        finalUrl: landed?.url ?? null,
        password: false,
        suggestion: found.url,
        warning: `${start.href}${landed && landed.url !== start.href ? ` (it went to ${landed.url})` : ''} has no password box; ${found.url} has one. Use that page instead.`,
      }
  }
  return {
    finalUrl: landed?.url ?? null,
    password: false,
    suggestion: null,
    warning: landed
      ? `${start.href}${landed.url !== start.href ? ` (it went to ${landed.url})` : ''} has no password box. Fine if the site draws its form later; otherwise save the page that shows the password box.`
      : `${start.href} did not answer, so it could not be checked.`,
  }
}
