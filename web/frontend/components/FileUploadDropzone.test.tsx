import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileUploadDropzone } from './FileUploadDropzone'

function createPaneDragDataTransfer() {
  return {
    types: ['application/x-aterm-pane-slot'],
    items: [
      {
        kind: 'string',
        type: 'application/x-aterm-pane-slot',
      },
    ],
    files: [],
  }
}

function createFileDragDataTransfer(file: File) {
  return {
    types: ['Files'],
    items: [
      {
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      },
    ],
    files: [file],
  }
}

describe('FileUploadDropzone', () => {
  it('ignores pane drag payloads', () => {
    const onFileSelect = vi.fn()

    render(
      <FileUploadDropzone onFileSelect={onFileSelect}>
        <div>aterm content</div>
      </FileUploadDropzone>,
    )

    const dropzone = screen.getByLabelText('File upload dropzone')
    const dataTransfer = createPaneDragDataTransfer()

    fireEvent.dragEnter(dropzone, { dataTransfer })
    fireEvent.dragOver(dropzone, { dataTransfer })
    fireEvent.drop(dropzone, { dataTransfer })

    expect(screen.queryByLabelText('Drop file to upload')).not.toBeInTheDocument()
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('shows the overlay and uploads the first file for file drags', () => {
    const onFileSelect = vi.fn()
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    render(
      <FileUploadDropzone onFileSelect={onFileSelect}>
        <div>aterm content</div>
      </FileUploadDropzone>,
    )

    const dropzone = screen.getByLabelText('File upload dropzone')
    const dataTransfer = createFileDragDataTransfer(file)

    fireEvent.dragEnter(dropzone, { dataTransfer })
    expect(screen.getByLabelText('Drop file to upload')).toBeInTheDocument()

    fireEvent.drop(dropzone, { dataTransfer })

    expect(onFileSelect).toHaveBeenCalledWith(file)
    expect(screen.queryByLabelText('Drop file to upload')).not.toBeInTheDocument()
  })
})
