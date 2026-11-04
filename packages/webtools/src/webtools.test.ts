import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWebCli, type WebIo } from './cli'
import { count, counterRow, openCounter, today } from './counter'
import { extractHtml } from './extract'
import { publicFallbackAllowed } from './fetch'
import { selectFocused } from './focus'
import { pyJson } from './json'
import { parseLite, parseRss } from './search'

const PAGE = `<html><head><title>Plain title</title><meta property="og:site_name" content="Site">
<meta name="author" content="Ann"></head><body><nav>menu menu</nav>
<article><h1>Heading</h1><p>First <a href="/x">link</a> and <code>code</code>.</p>
<ul><li>one</li><li>two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
<ol class="references"><li>cite</li></ol></article><footer>foot</footer></body></html>`

function harness(routes: Record<string, () => Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'webtools-'))
  const out: string[] = []
  const err: string[] = []
  const posted: unknown[] = []
  const calls: string[] = []
  const io: WebIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    dataDir: dir,
    env: { AICO_WEB_CACHE_DIR: join(dir, 'cache') },
    machine: 'testbox',
    now: () => new Date(2026, 10, 4, 12, 0, 0),
    statusUrl: 'http://127.0.0.1:1/api/status/rows',
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const key = String(url)
      if (key.includes('/api/status/rows')) {
        posted.push(JSON.parse(String(init?.body)))
        return new Response('{}')
      }
      calls.push(key)
      const route = Object.entries(routes).find(([prefix]) => key.startsWith(prefix))
      if (!route) throw new Error(`no route for ${key}`)
      return route[1]()
    }) as typeof fetch,
  }
  return { io, out, err, posted, calls, dir }
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('extraction', () => {
  it('keeps structure and metadata, drops page chrome and citation lists', () => {
    const page = extractHtml(PAGE)
    expect(page.title).toBe('Plain title')
    expect(page.site_name).toBe('Site')
    expect(page.author).toBe('Ann')
    expect(page.content).toContain('# Heading')
    expect(page.content).toContain('[link](/x)')
    expect(page.content).toContain('- one')
    expect(page.content).toContain('| a | b |')
    expect(page.content).not.toContain('menu')
    expect(page.content).not.toContain('foot')
    expect(page.content).not.toContain('cite')
  })
})

describe('focus', () => {
  it('keeps the chunk that answers the question when the page is over the limit', () => {
    const filler = Array.from(
      { length: 30 },
      (_, i) => `## Part ${i}\n\nNothing of note in part ${i}, just filler words.`,
    )
    filler[17] = '## Prices\n\nThe annual plan costs 480 dollars per seat.'
    const { text, meta } = selectFocused(filler.join('\n\n'), 'annual plan cost per seat', 300)
    expect(meta.focused).toBe(true)
    expect(text).toContain('480 dollars')
  })
  it('leaves a page that fits alone', () => {
    expect(selectFocused('short', 'q', 100).meta.focused).toBe(false)
  })
})

describe('output shape', () => {
  it('prints sorted keys with Python separators and ASCII escapes', () => {
    expect(pyJson({ b: 1, a: ['é'] }, null)).toBe('{"a": ["\\u00e9"], "b": 1}')
    expect(pyJson({ b: [], a: {} })).toBe('{\n  "a": {},\n  "b": []\n}')
  })
  it('parses DuckDuckGo lite and Bing RSS results', () => {
    const lite = `<a rel="nofollow" href="https://a.example/x?a=1&amp;b=2" class='result-link'>A <b>title</b></a>
      <td class='result-snippet'>some <b>snippet</b></td>
      <a rel="nofollow" href="https://b.example/" class='result-link'>B</a>`
    expect(parseLite(lite)).toEqual([
      { title: 'A title', url: 'https://a.example/x?a=1&b=2', snippet: 'some snippet' },
      { title: 'B', url: 'https://b.example/' },
    ])
    const rss = `<item><title>T &amp; U</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fn.example%2fa&amp;c=1</link><description>D</description><News:Source>Src</News:Source><pubDate>Wed</pubDate></item>`
    expect(parseRss(rss)).toEqual([
      { title: 'T & U', url: 'https://n.example/a', snippet: 'D', source: 'Src', published: 'Wed' },
    ])
  })
})

describe('aico web', () => {
  it('searches, falls back to Bing when DuckDuckGo fails, and counts the call as a fallback', async () => {
    const h = harness({
      'https://lite.duckduckgo.com': () => new Response('blocked', { status: 429 }),
      'https://www.bing.com/search': () =>
        new Response(
          '<item><title>R</title><link>https://r.example/</link><description>d</description></item>',
        ),
    })
    const code = await runWebCli(['search', 'hello', '--limit', '3', '--raw'], h.io)
    expect(code).toBe(0)
    const answer = JSON.parse(h.out.join(''))
    expect(answer.provider).toBe('bing')
    expect(answer.provider_errors[0].provider).toBe('duckduckgo')
    expect(answer.results[0].url).toBe('https://r.example/')
    const db = openCounter(h.dir)
    expect(today(db, h.io.now())).toMatchObject({ calls: 1, failures: 0, fallbacks: 1 })
    db.close()
    expect((h.posted[0] as { what: string }[])[0]?.what).toBe('Web search and fetch')
  })

  it('fetches a page, keeps the full extraction and refocuses it without the network', async () => {
    const h = harness({ 'https://page.example/': () => html(PAGE) })
    expect(await runWebCli(['fetch', 'https://page.example/a', '--max-chars', '100'], h.io)).toBe(0)
    const fetched = JSON.parse(h.out.join(''))
    expect(fetched.fetch_backend).toBe('direct')
    expect(fetched.title).toBe('Plain title')
    expect(fetched.coverage.full_extraction_retained).toBe(true)
    expect(JSON.parse(readFileSync(fetched.artifact_path, 'utf8')).content).toContain('# Heading')
    h.out.length = 0
    const before = h.calls.length
    expect(
      await runWebCli(['refocus', fetched.artifact_id, '--focus-query', 'two', '--compact'], h.io),
    ).toBe(0)
    expect(h.calls.length).toBe(before)
    expect(JSON.parse(h.out.join('')).network_access).toBe(false)
  })

  it('auto falls back to the Jina reader when the direct request fails; direct does not', async () => {
    const routes = {
      'https://down.example/': () => html('boom', 500),
      'https://r.jina.ai/': () =>
        new Response('# From reader\n\ntext', { headers: { 'content-type': 'text/plain' } }),
    }
    const auto = harness(routes)
    expect(
      await runWebCli(['fetch', '--url', 'https://down.example/p', '--compact'], auto.io),
    ).toBe(0)
    const viaReader = JSON.parse(auto.out.join(''))
    expect(viaReader.fetch_backend).toBe('jina')
    expect(viaReader.fallback_reason).toContain('direct request failed')
    const db = openCounter(auto.dir)
    expect(today(db, auto.io.now()).fallbacks).toBe(1)
    db.close()

    const direct = harness(routes)
    expect(
      await runWebCli(
        ['fetch', 'https://down.example/p', '--backend', 'direct', '--compact'],
        direct.io,
      ),
    ).toBe(1)
    expect(JSON.parse(direct.out.join('')).error).toBe('fetch_web_page request failed')
    expect(direct.calls.some((c) => c.startsWith('https://r.jina.ai'))).toBe(false)
    const failed = openCounter(direct.dir)
    expect(today(failed, direct.io.now())).toMatchObject({ calls: 1, failures: 1, fallbacks: 0 })
    failed.close()
  })

  it('never sends private, credentialed or secret-looking URLs to the public reader', () => {
    for (const url of [
      'http://localhost/x',
      'http://10.0.0.5/a',
      'http://host/',
      'https://user:pw@example.com/',
      'https://example.com/?api_key=1',
      'https://example.com/#frag',
      'https://nas.local/x',
    ])
      expect(publicFallbackAllowed(url)).toBe(false)
    expect(publicFallbackAllowed('https://example.com/a?page=2')).toBe(true)
  })

  it('batch reports failed fetches and exits 1', async () => {
    const h = harness({
      'https://ok.example/': () => html(PAGE),
      'https://bad.example/': () => html('x', 404),
    })
    expect(
      await runWebCli(
        [
          'batch',
          'https://ok.example/',
          'https://bad.example/',
          '--backend',
          'direct',
          '--compact',
        ],
        h.io,
      ),
    ).toBe(1)
    const answer = JSON.parse(h.out.join(''))
    expect(answer).toMatchObject({
      result_count: 2,
      failed_count: 1,
      error: 'web batch contains failed fetches',
    })
  })

  it('research searches then fetches the chosen result', async () => {
    const h = harness({
      'https://lite.duckduckgo.com': () =>
        new Response(
          `<a href="https://page.example/r" class='result-link'>R</a><td class='result-snippet'>s</td>`,
        ),
      'https://page.example/': () => html(PAGE),
    })
    expect(await runWebCli(['research', 'topic', '--backend', 'direct', '--compact'], h.io)).toBe(0)
    const answer = JSON.parse(h.out.join(''))
    expect(answer.fetched).toBe(true)
    expect(answer.page.title).toBe('Plain title')
  })

  it('leaves Lightpanda, doctor and benchmark to Agent Hub (exit 3) and rejects bad flags (exit 2)', async () => {
    const h = harness({})
    expect(await runWebCli(['fetch', 'https://a.example/', '--backend', 'lightpanda'], h.io)).toBe(
      3,
    )
    expect(await runWebCli(['fetch', 'https://a.example/', '--selector', 'main'], h.io)).toBe(3)
    expect(await runWebCli(['doctor'], h.io)).toBe(3)
    expect(await runWebCli(['search'], h.io)).toBe(2)
    expect(await runWebCli(['search', 'q', '--search-type', 'video'], h.io)).toBe(2)
    expect(await runWebCli(['fetch', 'ftp://a.example/'], h.io)).toBe(1)
    expect(h.err.join('')).toContain('ERROR')
  })
})

describe('counter row', () => {
  it('says what happened today in plain words and warns when half the calls failed', () => {
    const db = openCounter(mkdtempSync(join(tmpdir(), 'webtools-')))
    const at = new Date(2026, 10, 4, 9)
    expect(counterRow('box', today(db, at), at).meaning).toBe('No web calls today.')
    for (const failed of [true, true, false, false])
      count(db, at, { verb: 'fetch', failed, fallback: false })
    const row = counterRow('box', today(db, at), at)
    expect(row.state).toBe('warn')
    expect(row.meaning).toContain('4 calls today (fetch 4); 2 failed')
    db.close()
  })
})
