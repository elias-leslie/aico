import { StickyNote, Zap, Pin } from 'lucide-react';
import clsx from 'clsx';
import type { Note } from './types';

function relativeTime(dateStr: string | null): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
}

interface NoteItemProps {
    note: Note;
    selected: boolean;
    onClick: () => void;
}

export function NoteItem({ note, selected, onClick }: NoteItemProps) {
    const Icon = note.type === 'prompt' ? Zap : StickyNote;

    return (
        <button
            type="button"
            onClick={onClick}
            className={clsx(
                'w-full text-left px-3 py-2.5 transition-all duration-200 group',
                'border-l-2',
                selected
                    ? 'border-l-[var(--notes-accent)] bg-[var(--notes-accent-soft)]'
                    : 'border-transparent hover:border-l-[var(--notes-border-strong)] hover:bg-[var(--notes-bg-soft)]',
            )}
        >
            <div className="flex items-start gap-2 min-w-0">
                <Icon
                    className={clsx(
                        'w-3.5 h-3.5 mt-0.5 flex-shrink-0 transition-colors duration-150',
                        note.type === 'prompt'
                            ? 'text-[var(--notes-warning)]'
                            : selected
                                ? 'text-[var(--notes-accent)]'
                                : 'text-[var(--notes-text-dim)] group-hover:text-[var(--notes-text-muted)]',
                    )}
                />
                <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-1.5">
                        <span
                            className={clsx(
                                'text-[11px] leading-snug transition-colors duration-200',
                                selected ? 'font-medium text-[var(--notes-text-primary)]' : 'text-[var(--notes-text-muted)] group-hover:text-[var(--notes-text-primary)]',
                            )}
                            style={{ fontFamily: 'var(--notes-font-display)' }}
                        >
                            {note.title || 'Untitled'}
                        </span>
                        {note.pinned && (
                            <Pin className="h-2.5 w-2.5 flex-shrink-0 rotate-45 text-[var(--notes-accent)]" />
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className={clsx(
                            'text-[10px] tabular-nums transition-colors',
                            selected ? 'text-[var(--notes-text-muted)]' : 'text-[var(--notes-text-dim)]',
                        )}>
                            {relativeTime(note.updated_at)}
                        </span>
                        {note.tags.length > 0 && (
                            <span className={clsx(
                                'text-[10px] truncate transition-colors',
                                selected ? 'text-[var(--notes-text-muted)]' : 'text-[var(--notes-text-dim)]',
                            )}>
                                {note.tags.slice(0, 2).join(', ')}
                                {note.tags.length > 2 && ` +${note.tags.length - 2}`}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </button>
    );
}
