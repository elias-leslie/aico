import { useCallback, useEffect, useRef, useState } from 'react'

interface UseTabEditingProps {
  onSave: (sessionId: string, newName: string) => Promise<void>
}

interface UseTabEditingReturn {
  editingId: string | null
  editValue: string
  setEditValue: (value: string) => void
  editInputRef: React.RefObject<HTMLInputElement | null>
  startEdit: (sessionId: string, currentName: string) => void
  saveEdit: () => Promise<void>
  cancelEdit: () => void
  handleKeyDown: (e: React.KeyboardEvent) => void
}

/**
 * Hook for managing tab name editing state and handlers
 */
export function useTabEditing({
  onSave,
}: UseTabEditingProps): UseTabEditingReturn {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Start editing tab name
  const startEdit = useCallback((sessionId: string, currentName: string) => {
    setEditingId(sessionId)
    setEditValue(currentName)
  }, [])

  // Save edited name
  const saveEdit = useCallback(async () => {
    if (!editingId || !editValue.trim()) {
      setEditingId(null)
      return
    }

    await onSave(editingId, editValue.trim())
    setEditingId(null)
  }, [editingId, editValue, onSave])

  // Cancel editing
  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditValue('')
  }, [])

  // Handle keyboard events in edit mode
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        saveEdit()
      } else if (e.key === 'Escape') {
        cancelEdit()
      }
    },
    [saveEdit, cancelEdit],
  )

  return {
    editingId,
    editValue,
    setEditValue,
    editInputRef,
    startEdit,
    saveEdit,
    cancelEdit,
    handleKeyDown,
  }
}
