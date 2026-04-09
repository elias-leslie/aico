import { useState, useMemo } from 'react';
import { Search, Plus, StickyNote, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useNotesList, useCreateNote, useNoteTags } from './useNotes';
import { useNotesContext } from './NotesProvider';
import { NoteItem } from './NoteItem';
import type { Note } from './types';

interface NotesListProps {
    activeTab: 'note' | 'prompt';
    scopeFilter: string | undefined;
    selectedId: string | null;
    onSelect: (note: Note) => void;
}

export function NotesList({ activeTab, scopeFilter, selectedId, onSelect }: NotesListProps) {
    const { projectScope } = useNotesContext();
    const [search, setSearch] = useState('');
    const [activeTag, setActiveTag] = useState<string | null>(null);

    const listOptions = useMemo(() => ({
        type: activeTab,
        project_scope: scopeFilter,
        search: search || undefined,
        tag: activeTag ? [activeTag] : undefined,
        limit: 100,
    }), [activeTab, scopeFilter, search, activeTag]);

    const { data, isLoading } = useNotesList(listOptions);
    const { data: tagsData } = useNoteTags(scopeFilter);
    const createNote = useCreateNote();

    const handleCreate = () => {
        createNote.mutate(
            {
                title: '',
                type: activeTab,
                project_scope: scopeFilter ?? projectScope ?? 'global',
            },
            {
                onSuccess: (note) => onSelect(note),
            },
        );
    };

    const items = data?.items ?? [];
    const allTags = tagsData?.tags ?? [];

    return (
        <div
            className="flex h-full flex-col border-r border-[var(--notes-border)] bg-[var(--notes-bg-glass)]"
            style={{
                width: '30%',
                minWidth: 180,
                maxWidth: 280,
            }}
        >
            <div className="px-2 pt-2 pb-1.5">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--notes-text-dim)]" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        aria-label={`Search ${activeTab}s`}
                        className="w-full rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] py-1.5 pl-12 pr-2 text-xs text-[var(--notes-text-primary)] outline-none transition-all focus:border-[var(--notes-accent-border)] focus:ring-1 focus:ring-[var(--notes-accent-border)]"
                    />
                </div>
            </div>

            {allTags.length > 0 && (
                <div className="flex gap-1 px-2 pb-1.5 overflow-x-auto scrollbar-none">
                    {allTags.map(tag => (
                        <button
                            key={tag}
                            type="button"
                            onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                            className={clsx(
                                'px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 transition-colors border',
                                activeTag === tag
                                    ? 'border-[var(--notes-accent-border)] bg-[var(--notes-accent-soft)] text-[var(--notes-accent)]'
                                    : 'border-[var(--notes-border)] bg-[var(--notes-bg-overlay)] text-[var(--notes-text-dim)] hover:text-[var(--notes-text-muted)] hover:border-[var(--notes-border-strong)]',
                            )}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-0">
                {isLoading ? (
                    <div className="px-3 py-6 text-center text-xs text-[var(--notes-text-dim)]">Loading...</div>
                ) : items.length === 0 ? (
                    <div className="px-3 py-8 text-center">
                        {activeTab === 'prompt' ? (
                            <Zap className="mx-auto mb-2 h-4 w-4 text-[var(--notes-warning)]" />
                        ) : (
                            <StickyNote className="mx-auto mb-2 h-4 w-4 text-[var(--notes-text-dim)]" />
                        )}
                        <p className="text-[11px] text-[var(--notes-text-dim)]">
                            {search ? 'No matches' : `No ${activeTab}s yet`}
                        </p>
                    </div>
                ) : (
                    items.map(note => (
                        <NoteItem
                            key={note.id}
                            note={note}
                            selected={note.id === selectedId}
                            onClick={() => onSelect(note)}
                        />
                    ))
                )}
            </div>

            <div className="border-t border-[var(--notes-border)] px-2 py-2.5">
                <button
                    type="button"
                    onClick={handleCreate}
                    disabled={createNote.isPending}
                    className={clsx(
                        'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
                        'border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] text-[var(--notes-text-muted)]',
                        'hover:border-[var(--notes-accent-border)] hover:bg-[var(--notes-accent-soft)] hover:text-[var(--notes-accent)]',
                        createNote.isPending && 'opacity-50 cursor-wait',
                    )}
                >
                    <Plus className="h-3.5 w-3.5" />
                    New {activeTab === 'prompt' ? 'Prompt' : 'Note'}
                </button>
            </div>
        </div>
    );
}
