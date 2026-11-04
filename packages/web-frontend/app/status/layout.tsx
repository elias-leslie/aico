import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/lib/project-branding'

export const metadata: Metadata = { title: `Status · ${PRODUCT_NAME}` }

export default function StatusLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
