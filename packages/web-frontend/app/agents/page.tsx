import { ContextPage } from '@/components/ContextPage'
import { MemorySection } from '@/components/MemorySection'
import styles from './page.module.css'

export default function AgentsPage() {
  return (
    <div className={styles.scroll}>
      <ContextPage />
      <MemorySection />
    </div>
  )
}
