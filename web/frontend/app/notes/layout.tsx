import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/lib/project-branding'

// Its own window title, so a popped-out notes window is easy to find.
export const metadata: Metadata = { title: `Notes · ${PRODUCT_NAME}` }

export default function NotesLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
