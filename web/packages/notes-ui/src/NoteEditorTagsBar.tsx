import { X } from 'lucide-react';

interface NoteEditorTagsBarProps {
    tags: string[];
    tagInput: string;
    onTagInputChange: (v: string) => void;
    onTagKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onRemoveTag: (tag: string) => void;
}

export function NoteEditorTagsBar({ tags, tagInput, onTagInputChange, onTagKeyDown, onRemoveTag }: NoteEditorTagsBarProps) {
    return (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-[var(--notes-border)] px-4 py-2 scrollbar-none">
            {tags.map(tag => (
                <span key={tag} className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--notes-text-muted)]">
                    {tag}
                    <button type="button" onClick={() => onRemoveTag(tag)} className="transition-colors hover:text-[var(--notes-text-primary)]">
                        <X className="h-2.5 w-2.5" />
                    </button>
                </span>
            ))}
            <input
                value={tagInput}
                onChange={e => onTagInputChange(e.target.value)}
                onKeyDown={onTagKeyDown}
                placeholder={tags.length === 0 ? 'add tags...' : '+'}
                className="min-w-[40px] flex-shrink-0 bg-transparent text-[10px] text-[var(--notes-text-muted)] outline-none placeholder:text-[var(--notes-text-dim)]"
            />
        </div>
    );
}
