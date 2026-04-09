import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { StickyNote } from 'lucide-react';
import clsx from 'clsx';
import { NOTES_THEME_STYLE, useNotesContext } from './NotesProvider';
import { NotesPanel } from './NotesPanel';

const POPUP_FEATURES = 'width=700,height=800,menubar=no,toolbar=no,location=no,status=no';

export function NotesButton({ className, popOutUrl = '/notes' }: { className?: string; popOutUrl?: string }) {
    useNotesContext();
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

    // Position the portal panel relative to the button, adapting to its screen quadrant
    useEffect(() => {
        if (!open || !buttonRef.current) return;
        const rect = buttonRef.current.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const GAP = 8;
        const PANEL_W = 700;
        const style: React.CSSProperties = { width: PANEL_W, zIndex: 9999 };

        // Vertical: open downward if button is in top half, upward if bottom half
        if (rect.top < vh / 2) {
            style.top = rect.bottom + GAP;
            style.height = `calc(100vh - ${rect.bottom + GAP + 16}px)`;
        } else {
            style.bottom = vh - rect.top + GAP;
            style.height = `calc(100vh - ${vh - rect.top + GAP + 16}px)`;
        }
        style.maxHeight = 900;

        // Horizontal: open leftward if button is on the right, rightward if on the left
        const leftOffset = rect.left < vw / 2 ? Math.max(rect.left, GAP) : null;
        if (leftOffset !== null) {
            style.left = leftOffset;
        } else {
            style.right = Math.max(vw - rect.right, GAP);
        }

        // Clamp panel width if it would overflow viewport
        if (leftOffset !== null && leftOffset + PANEL_W > vw - GAP) {
            style.width = vw - leftOffset - GAP;
        }

        setPanelStyle(style);
    }, [open]);

    // Close on click outside
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (
                buttonRef.current?.contains(target) ||
                panelRef.current?.contains(target)
            ) return;
            setOpen(false);
        };
        const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
        return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
    }, [open]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open]);

    const toggle = useCallback(() => setOpen(v => !v), []);

    const handlePopOut = useCallback(() => {
        window.open(popOutUrl, 'summitflow-notes', POPUP_FEATURES);
        setOpen(false);
    }, [popOutUrl]);

    return (
        <>
            {/* Icon button */}
            <button
                ref={buttonRef}
                type="button"
                onClick={toggle}
                className={clsx(
                    'relative p-2 rounded-lg transition-all duration-200',
                    'text-[var(--notes-text-muted)] hover:text-[var(--notes-accent)] hover:bg-[var(--notes-bg-soft)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--notes-accent-border)]',
                    'active:bg-[var(--notes-bg-soft-hover)]',
                    open && 'text-[var(--notes-accent)] bg-[var(--notes-bg-soft)]',
                    className,
                )}
                style={NOTES_THEME_STYLE}
                aria-label="Notes"
                aria-expanded={open}
                title="Notes"
            >
                <StickyNote className="w-4 h-4" />
                {open && (
                    <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[var(--notes-accent)]" />
                )}
            </button>

            {/* Portal-mounted pop-down panel */}
            {open && createPortal(
                <div
                    ref={panelRef}
                    className={clsx(
                        'fixed flex flex-col overflow-hidden rounded-lg border',
                        'bg-[var(--notes-bg)] border-[var(--notes-border)]',
                        'overflow-hidden',
                    )}
                    style={{
                        ...NOTES_THEME_STYLE,
                        ...panelStyle,
                        backgroundColor: 'var(--notes-bg)',
                        boxShadow: 'var(--notes-shadow)',
                    }}
                >
                    <div className="h-px w-full flex-shrink-0" style={{
                        background: 'linear-gradient(90deg, transparent 0%, var(--notes-accent) 30%, color-mix(in srgb, var(--notes-accent) 70%, white 30%) 50%, var(--notes-accent) 70%, transparent 100%)',
                        opacity: 0.35,
                    }} />

                    <NotesPanel onPopOut={handlePopOut} />
                </div>,
                document.body,
            )}
        </>
    );
}
