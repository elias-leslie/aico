import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { readTab, tabLabel } from '@/lib/workbench-tabs'
import styles from './PlainMarkdown.module.css'

/** A local file (`/srv/…`, not `//host` or a URL): opened in place when the page can, else just named. */
const isLocalPath = (target: string) =>
  target.startsWith('/') && !target.startsWith('//')
const isWebLink = (target: string) => /^https?:\/\//i.test(target)

/** The pages of Aico itself an agent's text may point to (`/workbench?tab=designs…`). */
const APP_ROUTES =
  'workbench|needs-you|projects|machines|status|today|history|notes|captures|backups|agents|grants|logins|quota|recovery'
const APP_PATH = new RegExp(`^/(?:${APP_ROUTES})(?=[/?#]|$)`)
const isAppPath = (target: string) => APP_PATH.test(target)

/** How the text behind a link is opened. `onOpenPath` opens a local file; `onOpenApp` opens a page of
 * Aico itself (the Workbench in its own window, say), and without it the link just goes there. `buttons`
 * shows every link as a small button (agent text, where a bare underlined link would be the only amber
 * text on the card), finds bare web addresses and Aico paths too, and never shows markup. */
interface LinkOptions {
  onOpenPath?: (path: string) => void
  onOpenApp?: (path: string) => void
  buttons?: boolean
}

/** What a button for a bare web address or path says: where it leads, short. */
function linkLabel(target: string): string {
  if (isAppPath(target)) {
    const tab = readTab(
      new URLSearchParams(target.split('?')[1] ?? '').get('tab'),
    )
    return target.startsWith('/workbench') && tab
      ? `Open ${tabLabel(tab)}`
      : 'Open in Aico'
  }
  try {
    const url = new URL(target)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return target
  }
}

/** A trailing full stop or comma belongs to the sentence, not the address. */
function trimmed(text: string): [string, string] {
  const tail = /[.,;:!?]+$/.exec(text)?.[0] ?? ''
  return [text.slice(0, text.length - tail.length), tail]
}

function LinkButton({
  href,
  label,
  app,
  onOpenApp,
}: {
  href: string
  label: string
  app: boolean
  onOpenApp?: (path: string) => void
}) {
  return (
    <a
      className={clsx('lantern-btn small', styles.chip)}
      href={href}
      title={href}
      {...(app
        ? {
            onClick: (event) => {
              if (!onOpenApp) return
              event.preventDefault()
              onOpenApp(href)
            },
          }
        : { target: '_blank', rel: 'noopener noreferrer' })}
    >
      {label}
    </a>
  )
}

/** Bold, italics, code and links in a line, shown as formatted text, never as
 * the markup characters. Anything else stays as written. */
function inline(text: string, key: string, links: LinkOptions): ReactNode[] {
  const { onOpenPath, onOpenApp, buttons } = links
  const out: ReactNode[] = []
  const pattern = new RegExp(
    [
      '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)',
      '\\*\\*(.+?)\\*\\*',
      '`([^`]+)`',
      '(?<![\\w*])\\*([^*\\s][^*]*?)\\*(?![\\w*])',
      // Bare addresses, only where links are buttons.
      ...(buttons
        ? [
            '(?<![\\w/])(https?:\\/\\/[^\\s<>()\\]]+)',
            `(?<![\\w/.:-])(/(?:${APP_ROUTES})(?:[/?#][^\\s<>()]*)?)`,
          ]
        : []),
    ].join('|'),
    'g',
  )
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const id = `${key}-${index++}`
    let end = match.index + match[0].length
    if (match[1] !== undefined) {
      const label = match[1]
      const target = match[2] as string
      if (buttons && (isWebLink(target) || isAppPath(target)))
        out.push(
          <LinkButton
            key={id}
            href={target}
            label={label}
            app={isAppPath(target)}
            onOpenApp={onOpenApp}
          />,
        )
      else if (isWebLink(target))
        out.push(
          <a
            key={id}
            className={styles.link}
            href={target}
            target="_blank"
            rel="noreferrer noopener"
          >
            {label}
          </a>,
        )
      else if (isLocalPath(target) && onOpenPath)
        out.push(
          <button
            key={id}
            type="button"
            className={styles.link}
            title={`Open ${target}`}
            onClick={() => onOpenPath(target)}
          >
            {label}
          </button>,
        )
      else
        out.push(
          <span key={id} title={target}>
            {label}
          </span>,
        )
    } else if (match[3] !== undefined)
      out.push(<strong key={id}>{match[3]}</strong>)
    else if (match[4] !== undefined) out.push(<code key={id}>{match[4]}</code>)
    else if (match[5] !== undefined) out.push(<em key={id}>{match[5]}</em>)
    else {
      const [address, tail] = trimmed((match[6] ?? match[7]) as string)
      out.push(
        <LinkButton
          key={id}
          href={address}
          label={linkLabel(address)}
          app={match[7] !== undefined}
          onOpenApp={onOpenApp}
        />,
      )
      end -= tail.length
    }
    last = end
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const BULLET = /^\s*[-*]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const FENCE = /^\s*(```|~~~)/
const HEADING = /^#{1,6}\s+(.*)$/

/** Memory and prompt text is written in markdown; this shows it as plain
 * formatted text: paragraphs, bullet and numbered lists, headings as bold
 * lines, fenced code blocks, **bold**, *italic*, `code` and [links](url): a
 * web link opens in a new tab, a local file through `onOpenPath` (without it,
 * only its name shows). No HTML. */
export function PlainMarkdown({
  text,
  className,
  onOpenPath,
  onOpenApp,
  buttons,
}: {
  text: string
  className?: string
} & LinkOptions) {
  const links: LinkOptions = { onOpenPath, onOpenApp, buttons }
  const blocks: ReactNode[] = []
  let list: string[] = []
  let ordered = false
  let fence: string[] | null = null
  let paragraph: string[] = []
  const flushList = () => {
    if (!list.length) return
    const key = `l${blocks.length}`
    const items = list.map((item, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
      <li key={i}>{inline(item, `${key}-${i}`, links)}</li>
    ))
    blocks.push(
      ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
    )
    list = []
  }
  const flushParagraph = () => {
    if (!paragraph.length) return
    const key = `p${blocks.length}`
    blocks.push(<p key={key}>{inline(paragraph.join('\n'), key, links)}</p>)
    paragraph = []
  }
  const flushFence = () => {
    if (fence === null) return
    blocks.push(
      <pre key={`c${blocks.length}`}>
        <code>{fence.join('\n')}</code>
      </pre>,
    )
    fence = null
  }
  for (const line of text.split('\n')) {
    if (fence !== null) {
      if (FENCE.test(line)) flushFence()
      else fence.push(line)
      continue
    }
    if (FENCE.test(line)) {
      flushList()
      flushParagraph()
      fence = []
      continue
    }
    const bullet = BULLET.exec(line)
    const number = NUMBERED.exec(line)
    const heading = HEADING.exec(line)
    if (!line.trim()) {
      flushList()
      flushParagraph()
    } else if (bullet && !/^\s*\*\*/.test(line)) {
      flushParagraph()
      if (list.length && ordered) flushList()
      ordered = false
      list.push(bullet[1])
    } else if (number) {
      flushParagraph()
      if (list.length && !ordered) flushList()
      ordered = true
      list.push(number[1])
    } else if (heading) {
      flushList()
      flushParagraph()
      const key = `h${blocks.length}`
      blocks.push(
        <p key={key}>
          <strong>{inline(heading[1], key, links)}</strong>
        </p>,
      )
    } else {
      flushList()
      paragraph.push(line)
    }
  }
  flushFence()
  flushList()
  flushParagraph()
  return <div className={className}>{blocks}</div>
}
