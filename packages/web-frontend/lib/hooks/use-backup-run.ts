'use client'

import { useState } from 'react'
import { type BackupTarget, targetLabel } from '../backups'
import { backupsApi } from '../backups-api'

/**
 * Back up now: starts a copy to one destination and says how it went. `busy` is the destination being
 * started; `message` is the server's word (or the failure). `onStarted` re-reads the list.
 */
export function useBackupRun(onStarted: () => void) {
  const [busy, setBusy] = useState<BackupTarget | null>(null)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  async function run(target: BackupTarget) {
    setBusy(target)
    setMessage('')
    setFailed(false)
    try {
      const result = await backupsApi<{ message: string }>('/api/backups/run', {
        target,
      })
      setMessage(result.message || `${targetLabel(target)} is starting a copy.`)
      onStarted()
    } catch (error) {
      setFailed(true)
      setMessage((error as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return { busy, message, failed, run }
}
