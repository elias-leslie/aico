import { useState, useCallback, useRef } from 'react';
import { Copy, Check, Syringe, SendHorizontal, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useNotesContext } from './NotesProvider';

interface PromptActionsProps {
    content: string;
    noteId: string;
    onRefineStarted?: () => void;
}

export function PromptActions({ content, noteId, onRefineStarted }: PromptActionsProps) {
    const { canInject, onInject, api, capabilities } = useNotesContext();
    const [copied, setCopied] = useState(false);
    const [instruction, setInstruction] = useState('');
    const [refining, setRefining] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard API may fail in non-secure context */ }
    }, [content]);

    const handleInject = useCallback(() => {
        onInject?.(content);
    }, [content, onInject]);

    const handleRefine = useCallback(async () => {
        if (!instruction.trim()) return;
        setRefining(true);
        try {
            await api.refinePrompt(noteId, content, instruction.trim());
            setInstruction('');
            onRefineStarted?.();
        } catch (err) {
            console.warn('Refine request failed:', err);
        } finally {
            setRefining(false);
        }
    }, [api, noteId, content, instruction, onRefineStarted]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleRefine();
        }
    }, [handleRefine]);

    return (
        <div className="border-t border-[var(--notes-border)] bg-[var(--notes-bg-glass)]">
            {capabilities.prompt_refinement && (
                <div className="flex items-center gap-2 px-3 py-2">
                    <input
                        ref={inputRef}
                        value={instruction}
                        onChange={e => setInstruction(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Refine this prompt... (e.g. &quot;make it focus on error handling&quot;)"
                        disabled={refining}
                        className={clsx(
                            'flex-1 rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] px-3 py-1.5',
                            'text-xs text-[var(--notes-text-primary)] placeholder:text-[var(--notes-text-dim)]',
                            'outline-none focus:border-[var(--notes-accent-border)] focus:ring-1 focus:ring-[var(--notes-accent-border)]',
                            'transition-all',
                            refining && 'opacity-50',
                        )}
                    />
                    <button
                        type="button"
                        onClick={handleRefine}
                        disabled={refining || !instruction.trim()}
                        className={clsx(
                            'p-1.5 rounded-md transition-all duration-150',
                            refining ? 'text-[var(--notes-warning)]' :
                            instruction.trim()
                                ? 'text-[var(--notes-accent)] hover:bg-[var(--notes-accent-soft)]'
                                : 'cursor-not-allowed text-[var(--notes-text-dim)]',
                        )}
                        title="Send refinement"
                    >
                        {refining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SendHorizontal className="w-3.5 h-3.5" />}
                    </button>
                </div>
            )}

            <div className="flex items-center gap-2 px-3 pb-2.5">
                <button
                    type="button"
                    onClick={handleCopy}
                    className={clsx(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 border',
                        copied
                            ? 'border-[var(--notes-success-border)] bg-[var(--notes-success-soft)] text-[var(--notes-success)]'
                            : 'border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] text-[var(--notes-text-muted)] hover:border-[var(--notes-border-strong)] hover:bg-[var(--notes-bg-soft)] hover:text-[var(--notes-text-primary)]',
                    )}
                >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </button>

                {canInject && (
                    <button
                        type="button"
                        onClick={handleInject}
                        className={clsx(
                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200',
                            'border border-[var(--notes-accent-border)]',
                            'bg-[var(--notes-accent-soft)] text-[var(--notes-accent)]',
                            'hover:border-[var(--notes-accent)] hover:bg-[var(--notes-accent-soft)]',
                        )}
                    >
                        <Syringe className="w-3 h-3" />
                        Inject
                    </button>
                )}
            </div>
        </div>
    );
}
