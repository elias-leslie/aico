'use client'

import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'

/** Folds are kept per device, by section; a section nobody folded or opened follows its default. */
const FOLDS_KEY = 'aico-panel-folds'

/** Whether a section or project is open: the owner's last choice on this device, else `fallback`. */
export function usePanelFold(
  id: string,
  fallback: boolean,
): [boolean, (open: boolean) => void] {
  const [stored, setStored] = useLocalStorageState<Record<string, boolean>>(
    FOLDS_KEY,
    {},
  )
  const folds = stored && typeof stored === 'object' ? stored : {}
  return [
    folds[id] ?? fallback,
    (open) =>
      setStored((current) => ({
        ...(current && typeof current === 'object' ? current : {}),
        [id]: open,
      })),
  ]
}
