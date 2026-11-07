import { QuotaPage } from '@/components/quota/QuotaPage'

/** /quota: what each provider has left and what was spent. /status?q=usage still opens it. */
export default function QuotaRoute() {
  return (
    <div
      className="status-shell"
      style={{ height: 'var(--terminal-viewport-height, 100dvh)' }}
    >
      <QuotaPage />
    </div>
  )
}
