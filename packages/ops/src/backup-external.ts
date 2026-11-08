import { diskAway, hostAway, payloadTime } from './backup-drive'
import { type BackupState, migrated } from './backup-plan'
import type { Runtime } from './backup-runtime'
/** External owners keep their own schedules. Their artifact dates, never unit-success times, prove data age. */
export async function observeExternal(
  rt: Runtime,
  state: BackupState,
  sources?: string[],
): Promise<void> {
  // Each owner is a separate ssh round trip; ask them all at once.
  const owners = migrated.external.filter((s) => s.enabled && (!sources || sources.includes(s.id)))
  await Promise.all(
    owners.map(async (source) => {
      const probe = rt.cfg.externalProbes[source.id as keyof typeof rt.cfg.externalProbes]
      const old = state.copies[`external/${source.id}`]
      let running = false
      const markOff = () => {
        state.copies[`external/${source.id}`] = {
          ...old,
          source: source.id,
          target: 'drive',
          error: undefined,
          unreadSince: undefined,
          observed: 'offline',
          attemptedAt: rt.now().toISOString(),
        }
      }
      // Its artifact had no chance to get newer while off: its age counts from its return.
      const backAt = old?.observed === 'offline' ? { backAt: rt.now().toISOString() } : {}
      try {
        if ('statusCommand' in probe) {
          const status = await rt.run(probe.statusCommand)
          if (hostAway(status)) return markOff()
          if (status.code || !/^status: (stopped|running)\s*$/.test(status.out))
            throw new Error('The backup owner machine state could not be checked.')
          if (status.out.trim() === 'status: stopped') return markOff()
          running = true
        }
        let date: string | null = null
        if ('path' in probe && probe.path) {
          if (diskAway(probe.path)) return markOff()
          date = payloadTime(probe.path)
        } else if ('command' in probe && probe.command) {
          const result = await rt.run(probe.command)
          if (result.code)
            throw new Error(
              'The backup owner machine could not be reached; its last artifact date is shown.',
            )
          // `qm guest exec` wraps the output in JSON; `pct exec` prints it as is.
          const guest = (
            result.out.trimStart().startsWith('{')
              ? JSON.parse(result.out)
              : { exitcode: 0, 'out-data': result.out }
          ) as { exitcode?: number; 'out-data'?: string }
          if (guest.exitcode !== 0) throw new Error('The owner backup artifact could not be read.')
          const times = (guest['out-data'] ?? '')
            .split(/[^0-9.]+/)
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0)
          if (times.length) date = new Date(Math.max(...times) * 1000).toISOString()
        }
        if (!date) throw new Error('No readable owner backup artifact was found.')
        state.copies[`external/${source.id}`] = {
          source: source.id,
          target: 'drive',
          dataAt: date,
          observed: 'ok',
          attemptedAt: rt.now().toISOString(),
          ...(date === old?.dataAt && old.backAt ? { backAt: old.backAt } : {}),
          ...backAt,
        }
      } catch (error) {
        // A machine still booting, or a Proxmox host that doesn't answer yet, isn't a failed
        // backup: it fails only once it has stayed unreadable (`ownerUnreadMinutes`).
        const now = rt.now()
        const since = old?.unreadSince ?? now.toISOString()
        if (now.getTime() - Date.parse(since) < rt.cfg.schedule.ownerUnreadMinutes * 60000) {
          state.copies[`external/${source.id}`] = {
            ...old,
            source: source.id,
            target: 'drive',
            unreadSince: since,
            // It is on now, so the row stops saying off and waits on its last good date.
            ...(running && old?.observed === 'offline' ? { observed: undefined, ...backAt } : {}),
          }
          return
        }
        state.copies[`external/${source.id}`] = {
          ...old,
          unreadSince: since,
          source: source.id,
          target: 'drive',
          attemptedAt: rt.now().toISOString(),
          error: (error as Error).message,
          observed: 'failed',
        }
      }
    }),
  )
}
