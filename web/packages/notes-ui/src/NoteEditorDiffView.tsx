import { Check, XCircle, Wand2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { NOTES_PROSE_CLASS_NAME } from './NotesProvider';
import type { FormatProposal } from './types';

interface NoteEditorDiffViewProps {
    proposal: FormatProposal;
    currentTitle: string;
    currentContent: string;
    onAccept: () => void;
    onDiscard: () => void;
}

export function NoteEditorDiffView({ proposal, currentTitle, currentContent, onAccept, onDiscard }: NoteEditorDiffViewProps) {
    const titleChanged = !!proposal.proposed_title && proposal.proposed_title !== currentTitle;
    const contentChanged = proposal.proposed_content !== currentContent;

    return (
        <div className="flex h-full min-w-0 flex-col bg-[var(--notes-bg)]">
            <div className="flex items-center justify-between border-b border-[var(--notes-border)] px-4 py-2.5">
                <div className="flex items-center gap-2">
                    <Wand2 className="h-3.5 w-3.5 text-[var(--notes-warning)]" />
                    <span className="text-xs font-medium text-[var(--notes-text-primary)]">Proposed Changes</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <button type="button" onClick={onAccept}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--notes-success-border)] bg-[var(--notes-success-soft)] px-3 py-1.5 text-xs font-medium text-[var(--notes-success)] transition-colors">
                        <Check className="w-3 h-3" /> Accept
                    </button>
                    <button type="button" onClick={onDiscard}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--notes-text-muted)] transition-colors hover:text-[var(--notes-text-primary)]">
                        <XCircle className="w-3 h-3" /> Discard
                    </button>
                </div>
            </div>
            {titleChanged && (
                <div className="border-b border-[var(--notes-border)] px-4 py-2">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--notes-text-dim)]">Title</span>
                    <div className="flex gap-3 mt-1">
                        <div className="flex-1 min-w-0">
                            <span className="mb-0.5 block text-[10px] text-[var(--notes-danger)]">Current</span>
                            <span className="text-sm text-[var(--notes-text-muted)] line-through">{currentTitle || 'Untitled'}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <span className="mb-0.5 block text-[10px] text-[var(--notes-success)]">Proposed</span>
                            <span className="text-sm font-medium text-[var(--notes-text-primary)]">{proposal.proposed_title}</span>
                        </div>
                    </div>
                </div>
            )}
            <div className="flex flex-1 min-h-0 overflow-hidden">
                <div className="min-w-0 flex-1 overflow-y-auto border-r border-[var(--notes-border)]">
                    <div className="sticky top-0 border-b border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--notes-danger)]">Current</span>
                    </div>
                    {contentChanged
                        ? <div className="whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-[var(--notes-text-muted)]">{currentContent || '(empty)'}</div>
                        : <div className="px-3 py-4 text-center text-[11px] text-[var(--notes-text-dim)]">Content unchanged</div>
                    }
                </div>
                <div className="flex-1 min-w-0 overflow-y-auto">
                    <div className="sticky top-0 border-b border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--notes-success)]">Proposed</span>
                    </div>
                    {contentChanged
                        ? (
                            <div className={`px-3 py-2 text-sm ${NOTES_PROSE_CLASS_NAME}`}>
                                <Markdown remarkPlugins={[remarkGfm]}>{proposal.proposed_content ?? ''}</Markdown>
                            </div>
                        )
                        : <div className="px-3 py-4 text-center text-[11px] text-[var(--notes-text-dim)]">Content unchanged</div>
                    }
                </div>
            </div>
        </div>
    );
}
