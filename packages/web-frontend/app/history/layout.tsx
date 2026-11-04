import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/lib/project-branding'

export const metadata: Metadata = {
  title: `Recent sessions · ${PRODUCT_NAME}`,
}

export default function HistoryLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
