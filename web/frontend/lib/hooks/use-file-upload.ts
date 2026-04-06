'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildApiUrl } from '../api-config'

interface UploadResult {
  path: string
  filename: string
  size: number
  mime_type: string
}

interface UploadError {
  message: string
  status?: number
}

interface UseFileUploadReturn {
  /** Upload a file to the server */
  uploadFile: (file: File) => Promise<UploadResult | null>
  /** Upload progress (0-100) */
  progress: number
  /** Whether upload is in progress */
  isUploading: boolean
  /** Last upload error */
  error: UploadError | null
  /** Clear error state */
  clearError: () => void
}

/** Max upload size in bytes (must match backend MAX_FILE_SIZE_MB) */
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Hook for uploading files to the a-term server.
 * Uses XMLHttpRequest for progress tracking.
 */
export function useFileUpload(): UseFileUploadReturn {
  const [progress, setProgress] = useState(0)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<UploadError | null>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  const uploadFile = useCallback(
    async (file: File): Promise<UploadResult | null> => {
      // Client-side size validation before uploading
      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
        setError({ message: `File too large (${sizeMB}MB). Maximum size: 10MB` })
        return null
      }

      setIsUploading(true)
      setProgress(0)
      setError(null)

      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest()
        xhrRef.current = xhr
        const formData = new FormData()
        formData.append('file', file)

        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100)
            setProgress(percentComplete)
          }
        })

        xhr.addEventListener('load', () => {
          xhrRef.current = null
          setIsUploading(false)

          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result = JSON.parse(xhr.responseText) as UploadResult
              setProgress(100)
              resolve(result)
            } catch {
              setError({ message: 'Invalid server response' })
              resolve(null)
            }
          } else {
            // Handle error responses
            let message = 'Upload failed'
            try {
              const errorData = JSON.parse(xhr.responseText)
              message = errorData.detail || message
            } catch {
              // Use default message
            }

            setError({ message, status: xhr.status })
            resolve(null)
          }
        })

        xhr.addEventListener('error', () => {
          xhrRef.current = null
          setIsUploading(false)
          setError({ message: 'Network error during upload' })
          resolve(null)
        })

        xhr.addEventListener('abort', () => {
          xhrRef.current = null
          setIsUploading(false)
          setError({ message: 'Upload cancelled' })
          resolve(null)
        })

        xhr.open('POST', buildApiUrl('/api/a-term/files'))
        xhr.send(formData)
      })
    },
    [],
  )

  // Abort any in-flight upload on unmount
  useEffect(() => () => { xhrRef.current?.abort() }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    uploadFile,
    progress,
    isUploading,
    error,
    clearError,
  }
}
