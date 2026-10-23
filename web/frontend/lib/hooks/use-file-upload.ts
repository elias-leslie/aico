'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { buildApiUrl } from '../api-config'
import { apiFetch } from '../api-fetch'

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

interface UploadLimits {
  max_bytes: number
}

export const UPLOAD_LIMITS_QUERY_KEY = ['a-term', 'upload-limits'] as const

const BYTES_PER_MB = 1024 * 1024

function formatMB(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1).replace(/\.0$/, '')
}

/** The message for a file over the server's limit, the same as the server's own. */
export function fileTooLargeMessage(size: number, maxBytes: number): string {
  return `File too large (${formatMB(size)}MB). Maximum size: ${formatMB(maxBytes)}MB`
}

/**
 * Hook for uploading files to the a-term server.
 * Uses XMLHttpRequest for progress tracking.
 */
export function useFileUpload(): UseFileUploadReturn {
  const [progress, setProgress] = useState(0)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<UploadError | null>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  // The server's limit, so a bigger file is refused before it is sent. Until
  // it has loaded, the server's own 413 does the refusing.
  const { data: limits } = useQuery({
    queryKey: UPLOAD_LIMITS_QUERY_KEY,
    queryFn: () =>
      apiFetch<UploadLimits>(
        '/api/a-term/files/limits',
        undefined,
        'Failed to read the upload limit',
      ),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const maxBytes = limits?.max_bytes

  const uploadFile = useCallback(
    async (file: File): Promise<UploadResult | null> => {
      if (maxBytes !== undefined && file.size > maxBytes) {
        setError({ message: fileTooLargeMessage(file.size, maxBytes) })
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
    [maxBytes],
  )

  // Abort any in-flight upload on unmount
  useEffect(
    () => () => {
      xhrRef.current?.abort()
    },
    [],
  )

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
