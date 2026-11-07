import { ContextPage } from '@/components/ContextPage'
import { MemorySection } from '@/components/MemorySection'
import styles from './page.module.css'

/** Context (the address stays /agents): prompts, roles, memory and cost. */
export default function AgentsPage() {
  return (
    <div className={styles.scroll}>
      <ContextPage memory={<MemorySection />} />
    </div>
  )
}
