// Readable text from a page: the main article (or the whole body minus page chrome) as
// markdown that keeps headings, lists, tables, code and links, plus the page's own metadata.

import { type DefaultTreeAdapterMap, parse, parseFragment } from 'parse5'
import { normalizeWhitespace } from './focus'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

export interface Page {
  content: string
  format: 'markdown' | 'text'
  title?: string
  site_name?: string
  author?: string
  published?: string
  published_date_inferred?: boolean
  markdown_tokens_estimate?: number
}

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'canvas',
  'button',
  'select',
  'option',
  'head',
])
const CHROME = new Set(['nav', 'footer', 'aside', 'form'])
// Page furniture that holds no content of its own: citation lists, navigation boxes, edit links.
const FURNITURE = new Set([
  'references',
  'reflist',
  'mw-references-wrap',
  'navbox',
  'mw-editsection',
  'catlinks',
  'printfooter',
  'noprint',
  'toc',
  'sidebar',
])
const BLOCK = new Set(['div', 'section', 'article', 'main', 'figure', 'details', 'summary', 'body'])

const isElement = (node: Node): node is Element => 'tagName' in node
const kids = (node: Node): Node[] => ('childNodes' in node ? (node.childNodes as Node[]) : [])
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value
const textOf = (node: Node): string =>
  node.nodeName === '#text'
    ? (node as DefaultTreeAdapterMap['textNode']).value
    : isElement(node) && SKIP.has(node.tagName)
      ? ''
      : kids(node).map(textOf).join(' ')
const clean = (node: Node) => normalizeWhitespace(textOf(node))

function find(node: Node, test: (el: Element) => boolean, out: Element[] = []): Element[] {
  if (isElement(node) && test(node)) out.push(node)
  for (const child of kids(node)) find(child, test, out)
  return out
}

/** The text of an HTML snippet, entities decoded (titles and snippets from search results). */
export function plainText(html: string): string {
  return normalizeWhitespace(textOf(parseFragment(html)))
}

function inline(node: Node): string {
  if (node.nodeName === '#text')
    return (node as DefaultTreeAdapterMap['textNode']).value.replace(/\s+/g, ' ')
  if (!isElement(node) || SKIP.has(node.tagName)) return ''
  const inner = kids(node).map(inline).join('')
  const text = inner.replace(/\s+/g, ' ')
  switch (node.tagName) {
    case 'a': {
      const href = attr(node, 'href')
      return href && text.trim() && !href.startsWith('#') && !href.startsWith('javascript:')
        ? `[${text.trim()}](${href})`
        : text
    }
    case 'code':
      return text.trim() ? `\`${text.trim()}\`` : ''
    case 'strong':
    case 'b':
      return text.trim() ? `**${text.trim()}**` : text
    case 'em':
    case 'i':
      return text.trim() ? `*${text.trim()}*` : text
    case 'br':
      return ' '
    default:
      return text
  }
}

function table(el: Element): string {
  const rows = find(el, (n) => n.tagName === 'tr')
    .map((row) =>
      kids(row)
        .filter((c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'))
        .map(clean),
    )
    .filter((cells) => cells.length)
  return rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n')
}

function blocks(node: Node, out: string[]): void {
  if (node.nodeName === '#text') {
    const text = normalizeWhitespace((node as DefaultTreeAdapterMap['textNode']).value)
    if (text) out.push(text)
    return
  }
  if (!isElement(node) || SKIP.has(node.tagName)) return
  const tag = node.tagName
  if (/^h[1-6]$/.test(tag)) {
    const text = clean(node).replace(/¶$/, '').trim()
    if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
  } else if (tag === 'pre') {
    const text = textOfPre(node).trim()
    if (text) out.push(`\`\`\`\n${text}\n\`\`\``)
  } else if (tag === 'table') {
    const text = table(node)
    if (text) out.push(text)
  } else if (tag === 'ul' || tag === 'ol') {
    const items = kids(node)
      .filter((c): c is Element => isElement(c) && c.tagName === 'li')
      .map((li, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${normalizeWhitespace(inline(li))}`)
      .filter((line) => line.length > 2)
    if (items.length) out.push(items.join('\n'))
  } else if (tag === 'p' || tag === 'blockquote' || tag === 'li' || tag === 'dd' || tag === 'dt') {
    const text = normalizeWhitespace(inline(node))
    if (text) out.push(tag === 'blockquote' ? `> ${text}` : text)
  } else if (BLOCK.has(tag) || tag === 'span' || tag === 'dl' || tag === 'tbody') {
    // A container holding only inline content is one paragraph, not a pile of fragments.
    if (kids(node).every((c) => !isElement(c) || !isBlockish(c))) {
      const text = normalizeWhitespace(inline(node))
      if (text) out.push(text)
    } else {
      let run: Node[] = []
      const flush = () => {
        const text = normalizeWhitespace(run.map(inline).join(''))
        if (text) out.push(text)
        run = []
      }
      for (const child of kids(node)) {
        if (isElement(child) && isBlockish(child)) {
          flush()
          blocks(child, out)
        } else run.push(child)
      }
      flush()
    }
  } else for (const child of kids(node)) blocks(child, out)
}

const BLOCKISH = new Set([
  ...BLOCK,
  'p',
  'ul',
  'ol',
  'li',
  'table',
  'pre',
  'blockquote',
  'dl',
  'dd',
  'dt',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tbody',
])
const isBlockish = (el: Element) => BLOCKISH.has(el.tagName)
const textOfPre = (node: Node): string =>
  node.nodeName === '#text'
    ? (node as DefaultTreeAdapterMap['textNode']).value
    : kids(node).map(textOfPre).join('')

/** The tree without page chrome (navigation, footers, forms, ads' asides). */
function stripChrome(node: Node): void {
  if ('childNodes' in node) {
    node.childNodes = (node.childNodes as Node[]).filter(
      (child) =>
        !(
          isElement(child) &&
          (SKIP.has(child.tagName) ||
            CHROME.has(child.tagName) ||
            (attr(child, 'class') ?? '').split(/\s+/).some((name) => FURNITURE.has(name)) ||
            (child.tagName === 'sup' && (attr(child, 'class') ?? '').includes('reference')))
        ),
    ) as never
    for (const child of node.childNodes as Node[]) stripChrome(child)
  }
}

function meta(root: Node, names: string[]): string | undefined {
  for (const name of names) {
    const el = find(
      root,
      (n) =>
        n.tagName === 'meta' &&
        [attr(n, 'property'), attr(n, 'name'), attr(n, 'itemprop')].includes(name),
    )[0]
    const value = el && attr(el, 'content')?.trim()
    if (value) return value
  }
  return undefined
}

/** The page's own metadata and readable markdown (text when no structure was found). */
export function extractHtml(html: string): Page {
  const document = parse(html)
  const titleEl = find(document, (n) => n.tagName === 'title')[0]
  const title =
    meta(document, ['og:title', 'twitter:title']) ?? (titleEl && clean(titleEl)) ?? undefined
  const siteName = meta(document, ['og:site_name'])
  const author = meta(document, ['author', 'article:author'])
  const timeEl = find(document, (n) => n.tagName === 'time' && Boolean(attr(n, 'datetime')))[0]
  const published =
    meta(document, ['article:published_time', 'datePublished', 'pubdate']) ??
    (timeEl && attr(timeEl, 'datetime'))

  const body = find(document, (n) => n.tagName === 'body')[0] ?? document
  const mains = find(
    body,
    (n) => n.tagName === 'article' || n.tagName === 'main' || attr(n, 'role') === 'main',
  )
  const root = mains.sort((a, b) => textOf(b).length - textOf(a).length)[0] ?? body
  stripChrome(root)
  const parts: string[] = []
  blocks(root, parts)
  let content = parts.join('\n\n').trim()
  let format: Page['format'] = 'markdown'
  if (!content) {
    content = clean(body)
    format = 'text'
  }
  return {
    content,
    format,
    ...(title && { title }),
    ...(siteName && { site_name: siteName }),
    ...(author && { author }),
    ...(published && { published, published_date_inferred: false }),
  }
}
