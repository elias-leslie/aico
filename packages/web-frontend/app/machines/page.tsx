import { MachinesPage } from '@/components/machines/MachinesPage'

/** /machines: every machine, whether it is up, and power. /status?kind=machine still opens it. */
export default function MachinesRoute() {
  return (
    <div
      className="status-shell"
      style={{ height: 'var(--terminal-viewport-height, 100dvh)' }}
    >
      <MachinesPage />
    </div>
  )
}
