import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue
    try {
      const stored = localStorage.getItem(key)
      return stored ? JSON.parse(stored) : defaultValue
    } catch {
      return defaultValue
    }
  })

  const setStoredValue = useCallback(
    (newValue: SetStateAction<T>) => {
      setValue((currentValue) => {
        const resolvedValue =
          typeof newValue === 'function'
            ? (newValue as (prevState: T) => T)(currentValue)
            : newValue

        try {
          if (resolvedValue === null || typeof resolvedValue === 'undefined') {
            localStorage.removeItem(key)
          } else {
            localStorage.setItem(key, JSON.stringify(resolvedValue))
          }
        } catch {
          // Ignore localStorage errors
        }

        return resolvedValue
      })
    },
    [key],
  )

  return [value, setStoredValue]
}
