import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { NOTES_PROSE_CLASS_NAME } from './NotesProvider';
import type { EditMode } from './useNoteEditorState';

interface NoteEditorContentProps {
    mode: EditMode;
    content: string;
    onContentChange: (v: string) => void;
}

export function NoteEditorContent({ mode, content, onContentChange }: NoteEditorContentProps) {
    if (mode === 'edit') {
        return (
            <div className="flex-1 min-h-0 overflow-y-auto">
                <textarea
                    value={content}
                    onChange={e => onContentChange(e.target.value)}
                    placeholder="Write something..."
                    className="h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-sm leading-relaxed text-[var(--notes-text-primary)] outline-none placeholder:text-[var(--notes-text-dim)]"
                    spellCheck={false}
                />
            </div>
        );
    }
    return (
        <div className="flex-1 min-h-0 overflow-y-auto">
            <div className={`px-4 py-3 text-sm ${NOTES_PROSE_CLASS_NAME}`}>
                {content
                    ? <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
                    : <p className="italic text-[var(--notes-text-dim)]">Nothing here yet.</p>
                }
            </div>
        </div>
    );
}
