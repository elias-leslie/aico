import type { ReactNode } from 'react'

function parts(text: string, pattern: RegExp) {
  let offset = 0
  return text
    .split(pattern)
    .map((part) => {
      const item = { part, offset }
      offset += part.length
      return item
    })
    .filter(({ part }) => part.length > 0)
}
function inline(text: string): ReactNode[] {
  return parts(text, /(`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map(
    ({ part, offset }) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
        <code key={offset}>{part.slice(1, -1)}</code>
      ) : part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
        <strong key={offset}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('*') &&
        !part.startsWith('**') &&
        part.endsWith('*') &&
        part.length > 2 ? (
        <em key={offset}>{part.slice(1, -1)}</em>
      ) : (
        part
      ),
  )
}
/** The small transcript subset: emphasis and code; HTML stays plain text. */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="chat-text">
      {parts(text, /(```[\s\S]*?(?:```|$))/g).map(({ part, offset }) =>
        part.startsWith('```') ? (
          <pre key={offset}>
            <code>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code>
          </pre>
        ) : (
          <span key={offset}>{inline(part)}</span>
        ),
      )}
    </div>
  )
}
