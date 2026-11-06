import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/lib/project-branding'

export const metadata: Metadata = { title: `Projects · ${PRODUCT_NAME}` }

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
