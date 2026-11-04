import { BookOpen } from 'lucide-react'
import Link from 'next/link'

export function ContextLauncher({
  variant = 'row',
}: {
  variant?: 'row' | 'icon'
}) {
  return (
    <Link
      href="/agents"
      className={
        variant === 'icon'
          ? 'lantern-icon-btn compact'
          : 'lantern-btn ghost small'
      }
      title="Agents and prompts"
      aria-label="Agents and prompts"
    >
      <BookOpen className="h-4 w-4" aria-hidden="true" />
      {variant === 'row' && 'Agents'}
    </Link>
  )
}
