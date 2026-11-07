import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/lib/project-branding'

export const metadata: Metadata = {
  title: `Context · ${PRODUCT_NAME}`,
}

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
