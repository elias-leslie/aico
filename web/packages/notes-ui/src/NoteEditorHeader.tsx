import { Pin, PinOff, Eye, Pencil, Trash2, Wand2, Loader2, History } from 'lucide-react';
import clsx from 'clsx';
import type { EditMode, SaveState } from './useNoteEditorState';
import type { FormatState } from './useFormatProposal';

interface NoteEditorHeaderProps {
    title: string;
    pinned: boolean;
    mode: EditMode;
    saveState: SaveState;
    formatState: FormatState;
    canFormat: boolean;
    contentLength: number;
    confirmDelete: boolean;
    onTitleChange: (val: string) => void;
    onStartFormat: () => void;
    onToggleHistory: () => void;
    onTogglePin: () => void;
    onSetMode: (m: EditMode) => void;
    onDelete: () => void;
}

export function NoteEditorHeader({
    title, pinned, mode, saveState, formatState, contentLength,
    canFormat,
    confirmDelete, onTitleChange, onStartFormat, onToggleHistory,
    onTogglePin, onSetMode, onDelete,
}: NoteEditorHeaderProps) {
    return (
        <div className="flex items-center gap-3 border-b border-[var(--notes-border)] px-4 py-2.5">
            <input
                value={title}
                onChange={e => onTitleChange(e.target.value)}
                placeholder="Untitled"
                className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[var(--notes-text-primary)] outline-none placeholder:text-[var(--notes-text-dim)]"
                style={{ fontFamily: 'var(--notes-font-display)' }}
            />
            <div className="flex items-center gap-0.5 flex-shrink-0">
                {formatState === 'pending' && (
                    <span className="mr-1.5 animate-pulse text-[10px] tabular-nums text-[var(--notes-warning)]">formatting...</span>
                )}
                {formatState === 'failed' && (
                    <span className="mr-1.5 text-[10px] tabular-nums text-[var(--notes-danger)]">format failed</span>
                )}
                {formatState !== 'pending' && saveState !== 'idle' && (
                    <span className={clsx(
                        'text-[10px] tabular-nums mr-1.5 transition-colors',
                        saveState === 'saving' ? 'text-[var(--notes-text-dim)]' : 'text-[var(--notes-success)]',
                    )}>
                        {saveState === 'saving' ? 'saving...' : 'saved'}
                    </span>
                )}
                {canFormat && (
                    <button type="button" onClick={onStartFormat}
                        disabled={formatState === 'pending' || contentLength < 50}
                        className={clsx(
                            'p-1.5 rounded-md transition-all duration-150',
                            formatState === 'pending' ? 'text-[var(--notes-warning)]' :
                            'text-[var(--notes-text-dim)] hover:bg-[var(--notes-bg-soft)] hover:text-[var(--notes-warning)] disabled:cursor-not-allowed disabled:opacity-30',
                        )}
                        title="Format note (title + content cleanup)">
                        {formatState === 'pending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                    </button>
                )}
                <button type="button" onClick={onToggleHistory}
                    className="rounded-md p-1.5 text-[var(--notes-text-dim)] transition-all duration-150 hover:bg-[var(--notes-bg-soft)] hover:text-[var(--notes-accent)]"
                    title="Version history">
                    <History className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={onTogglePin}
                    className={clsx(
                        'p-1.5 rounded-md transition-all duration-150',
                        pinned ? 'bg-[var(--notes-accent-soft)] text-[var(--notes-accent)]' : 'text-[var(--notes-text-dim)] hover:bg-[var(--notes-bg-soft)] hover:text-[var(--notes-text-primary)]',
                    )}
                    title={pinned ? 'Unpin' : 'Pin'}>
                    {pinned ? <Pin className="w-3.5 h-3.5 rotate-45" /> : <PinOff className="w-3.5 h-3.5" />}
                </button>
                <div className="ml-0.5 flex items-center rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)]">
                    <button type="button" onClick={() => onSetMode('edit')}
                        className={clsx('rounded-l-md p-1.5 transition-all duration-150', mode === 'edit' ? 'bg-[var(--notes-bg-soft-hover)] text-[var(--notes-text-primary)]' : 'text-[var(--notes-text-dim)] hover:text-[var(--notes-text-primary)]')}
                        title="Edit"><Pencil className="w-3 h-3" /></button>
                    <button type="button" onClick={() => onSetMode('preview')}
                        className={clsx('rounded-r-md p-1.5 transition-all duration-150', mode === 'preview' ? 'bg-[var(--notes-bg-soft-hover)] text-[var(--notes-text-primary)]' : 'text-[var(--notes-text-dim)] hover:text-[var(--notes-text-primary)]')}
                        title="Preview"><Eye className="w-3 h-3" /></button>
                </div>
                <button type="button" onClick={onDelete}
                    className={clsx('ml-0.5 rounded-md p-1.5 transition-all duration-150', confirmDelete ? 'bg-[var(--notes-danger-soft)] text-[var(--notes-danger)]' : 'text-[var(--notes-text-dim)] hover:bg-[var(--notes-bg-soft)] hover:text-[var(--notes-text-primary)]')}
                    title={confirmDelete ? 'Click again to confirm' : 'Delete'}>
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}
