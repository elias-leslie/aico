import { ContextPage } from '@/components/ContextPage'
import { MemorySection } from '@/components/MemorySection'

/** Context (the address stays /agents): prompts, roles, memory and cost. The Settings dialog scrolls it. */
export default function AgentsPage() {
  return <ContextPage memory={<MemorySection />} />
}
