// What the owner calls each backup target, in Status rows, the Backups page and the CLI alike.

export const BACKUP_TARGET_NAMES = {
  native: 'T7',
  drive: 'Drive',
  append: 'CT 160',
  external: 'Owner backup',
} as const

export type BackupTargetId = keyof typeof BACKUP_TARGET_NAMES

/** The target's name, or the id itself for a target this list does not know. */
export function backupTargetName(target: string): string {
  return (BACKUP_TARGET_NAMES as Record<string, string>)[target] ?? target
}
