// Local endpoints of the one authenticated fleet connection. SSH is manual rescue only.
import { join } from 'node:path'

export function linkPaths(dir: string) {
  return {
    dir,
    control: join(dir, 'exec.sock'),
    forwarded: join(dir, 'control.sock'),
    sync: join(dir, 'sync.sock'),
  }
}
