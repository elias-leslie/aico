import { useState } from 'react';
import { StickyNote, ExternalLink, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { NOTES_THEME_STYLE, useNotesContext } from './NotesProvider';
import { NotesList } from './NotesList';
import { NoteEditor } from './NoteEditor';
import type { Note } from './types';

interface NotesPanelProps {
    onPopOut?: () => void;
}

export function NotesPanel({ onPopOut }: NotesPanelProps) {
    const { projectScope, scopeOptions, getScopeLabel } = useNotesContext();
    const [activeTab, setActiveTab] = useState<'note' | 'prompt'>('note');
    const [scopeFilter, setScopeFilter] = useState<string>(projectScope || 'global');
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);
    const [showScopeMenu, setShowScopeMenu] = useState(false);

    const availableScopeOptions = scopeOptions.length > 0
        ? scopeOptions
        : [{ value: projectScope || 'global', label: getScopeLabel(projectScope || 'global'), known: false }];
    const activeScopeLabel = getScopeLabel(scopeFilter);

    return (
        <div
            className="flex min-h-0 flex-1 flex-col bg-[var(--notes-bg)] text-[var(--notes-text-primary)]"
            style={NOTES_THEME_STYLE}
        >
            <div
                className="flex flex-shrink-0 items-center justify-between border-b border-[var(--notes-border)] bg-[var(--notes-bg-glass)] px-3 py-2.5"
            >
                <div className="flex items-center gap-2">
                    <StickyNote className="h-3.5 w-3.5 text-[var(--notes-accent)]" />
                    <span className="text-xs font-semibold tracking-wide text-[var(--notes-text-primary)]" style={{ fontFamily: 'var(--notes-font-display)' }}>Notes</span>
                </div>

                <div className="flex items-center gap-1.5">
                    <div className="mr-1 flex items-center rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)]">
                        <button
                            type="button"
                            onClick={() => { setActiveTab('note'); setSelectedNote(null); }}
                            className={clsx(
                                'px-2.5 py-1 text-[10px] font-medium rounded-l-md transition-colors',
                                activeTab === 'note'
                                    ? 'bg-[var(--notes-bg-soft-hover)] text-[var(--notes-text-primary)]'
                                    : 'text-[var(--notes-text-dim)] hover:text-[var(--notes-text-muted)]',
                            )}
                        >
                            Notes
                        </button>
                        <button
                            type="button"
                            onClick={() => { setActiveTab('prompt'); setSelectedNote(null); }}
                            className={clsx(
                                'px-2.5 py-1 text-[10px] font-medium rounded-r-md transition-colors',
                                activeTab === 'prompt'
                                    ? 'bg-[var(--notes-warning-soft)] text-[var(--notes-warning)]'
                                    : 'text-[var(--notes-text-dim)] hover:text-[var(--notes-text-muted)]',
                            )}
                        >
                            Prompts
                        </button>
                    </div>

                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setShowScopeMenu(v => !v)}
                            className="flex items-center gap-1 rounded border border-[var(--notes-border)] bg-[var(--notes-bg-overlay)] px-2 py-1 text-[10px] font-medium text-[var(--notes-text-muted)] transition-colors hover:text-[var(--notes-text-primary)]"
                            aria-label={`Notes scope: ${activeScopeLabel}`}
                        >
                            {activeScopeLabel}
                            <ChevronDown className="h-2.5 w-2.5" />
                        </button>
                        {showScopeMenu && (
                            <>
                                <div className="fixed inset-0 z-[101]" onClick={() => setShowScopeMenu(false)} />
                                <div
                                    className="absolute right-0 top-full z-[102] mt-1 w-40 overflow-hidden rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg)] py-1"
                                    style={{
                                        boxShadow: 'var(--notes-shadow)',
                                    }}
                                >
                                    {availableScopeOptions.map(scope => (
                                        <button
                                            key={scope.value}
                                            type="button"
                                            onClick={() => { setScopeFilter(scope.value); setShowScopeMenu(false); }}
                                            className={clsx(
                                                'w-full text-left px-3 py-1.5 text-[11px] transition-colors',
                                                scopeFilter === scope.value ? 'bg-[var(--notes-accent-soft)] text-[var(--notes-accent)]' : 'text-[var(--notes-text-muted)] hover:bg-[var(--notes-bg-soft)] hover:text-[var(--notes-text-primary)]',
                                            )}
                                        >
                                            {scope.label}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    {onPopOut && (
                        <button
                            type="button"
                            onClick={onPopOut}
                            className="rounded p-1 text-[var(--notes-text-dim)] transition-colors hover:text-[var(--notes-accent)]"
                            title="Open in separate window"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>

            <div
                className="flex min-h-0 flex-1 overflow-hidden bg-[var(--notes-bg)]"
            >
                <NotesList
                    activeTab={activeTab}
                    scopeFilter={scopeFilter}
                    selectedId={selectedNote?.id ?? null}
                    onSelect={setSelectedNote}
                />
                <div className="min-w-0 flex-1 bg-[var(--notes-bg)]">
                    {selectedNote ? (
                        <NoteEditor
                            note={selectedNote}
                            onDeleted={() => setSelectedNote(null)}
                        />
                    ) : (
                        <div className="flex h-full items-center justify-center bg-[var(--notes-bg)]">
                            <div className="text-center space-y-3">
                                <div className="relative mx-auto w-12 h-12 flex items-center justify-center">
                                    <div className="absolute inset-0 rounded-xl border border-[var(--notes-accent-border)] bg-[var(--notes-accent-soft)]" />
                                    <StickyNote className="relative h-5 w-5 text-[var(--notes-text-dim)]" />
                                </div>
                                <div>
                                    <p className="text-xs font-medium text-[var(--notes-text-muted)]">Select or create a {activeTab}</p>
                                    <p className="mt-1 text-[10px] text-[var(--notes-text-dim)]">Use the sidebar to browse, or press + to start fresh</p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
