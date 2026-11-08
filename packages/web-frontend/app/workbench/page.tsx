import type { Metadata } from 'next'
import { WORKBENCH_TITLE } from '@/lib/workbench-tabs'
import { WorkbenchScreen } from './Workbench'

export const metadata: Metadata = { title: WORKBENCH_TITLE }

export default function WorkbenchPage() {
  return <WorkbenchScreen />
}
