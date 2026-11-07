import type { ReactNode } from 'react'

/** Bold, italics and code in a line, shown as formatted text, never as the
 * markup characters. Anything else stays as written. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern =
    /\*\*(.+?)\*\*|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const id = `${key}-${index++}`
    if (match[1] !== undefined) out.push(<strong key={id}>{match[1]}</strong>)
    else if (match[2] !== undefined) out.push(<code key={id}>{match[2]}</code>)
    else out.push(<em key={id}>{match[3]}</em>)
    last = match.index + match[0].length
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
 * lines, fenced code blocks, **bold**, *italic* and `code`. No HTML, no
 * links. */
export function PlainMarkdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
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
      <li key={i}>{inline(item, `${key}-${i}`)}</li>
    ))
    blocks.push(
      ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
    )
    list = []
  }
  const flushParagraph = () => {
    if (!paragraph.length) return
    const key = `p${blocks.length}`
    blocks.push(<p key={key}>{inline(paragraph.join('\n'), key)}</p>)
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
          <strong>{inline(heading[1], key)}</strong>
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
