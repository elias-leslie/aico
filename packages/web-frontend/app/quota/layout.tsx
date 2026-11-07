import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/lib/project-branding'

export const metadata: Metadata = { title: `Quota · ${PRODUCT_NAME}` }

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
