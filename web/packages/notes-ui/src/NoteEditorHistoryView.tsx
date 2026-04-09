import { History, X, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import type { NoteVersion } from './types';

interface NoteEditorHistoryViewProps {
    versions: NoteVersion[];
    loadingVersions: boolean;
    versionError: string | null;
    onClose: () => void;
    onRevert: (versionId: string) => void;
}

function relativeTime(dateStr: string | null): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function VersionItem({ v, onRevert }: { v: NoteVersion; onRevert: (id: string) => void }) {
    return (
        <div className="group border-b border-[var(--notes-border)] px-4 py-3 transition-colors hover:bg-[var(--notes-bg-soft)]">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[var(--notes-text-primary)]">v{v.version}</span>
                    <span className="text-[10px] text-[var(--notes-text-dim)]">{relativeTime(v.created_at)}</span>
                    <span className={clsx(
                        'text-[10px] px-1.5 py-0.5 rounded border',
                        v.change_source === 'format_accept' ? 'border-[var(--notes-warning-border)] bg-[var(--notes-warning-soft)] text-[var(--notes-warning)]' :
                        v.change_source === 'revert' ? 'border-[var(--notes-accent-border)] bg-[var(--notes-accent-soft)] text-[var(--notes-accent)]' :
                        'border-[var(--notes-border)] bg-[var(--notes-bg-elevated)] text-[var(--notes-text-dim)]',
                    )}>
                        {v.change_source.replace('_', ' ')}
                    </span>
                </div>
                <button type="button" onClick={() => onRevert(v.id)}
                    className="inline-flex items-center gap-1 rounded border border-[var(--notes-accent-border)] px-2 py-1 text-[10px] font-medium text-[var(--notes-accent)] opacity-0 transition-all hover:bg-[var(--notes-accent-soft)] group-hover:opacity-100">
                    <RotateCcw className="h-2.5 w-2.5" /> Revert
                </button>
            </div>
            <p className="mt-1 truncate text-[11px] text-[var(--notes-text-muted)]">{v.title || 'Untitled'}</p>
            <p className="mt-0.5 line-clamp-2 text-[10px] text-[var(--notes-text-dim)]">{v.content.substring(0, 150)}</p>
        </div>
    );
}

export function NoteEditorHistoryView({
    versions,
    loadingVersions,
    versionError,
    onClose,
    onRevert,
}: NoteEditorHistoryViewProps) {
    return (
        <div className="flex h-full min-w-0 flex-col bg-[var(--notes-bg)]">
            <div className="flex items-center justify-between border-b border-[var(--notes-border)] px-4 py-2.5">
                <div className="flex items-center gap-2">
                    <History className="h-3.5 w-3.5 text-[var(--notes-accent)]" />
                    <span className="text-xs font-medium text-[var(--notes-text-primary)]">Version History</span>
                    <span className="text-[10px] text-[var(--notes-text-dim)]">({versions.length})</span>
                </div>
                <button type="button" onClick={onClose} className="rounded p-1 text-[var(--notes-text-dim)] transition-colors hover:text-[var(--notes-text-primary)]">
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {loadingVersions && <div className="px-4 py-6 text-center text-xs text-[var(--notes-text-dim)]">Loading...</div>}
                {!loadingVersions && versionError && (
                    <div className="px-4 py-6 text-center text-xs text-[var(--notes-danger)]">
                        Unable to load versions
                    </div>
                )}
                {!loadingVersions && !versionError && versions.length === 0 && (
                    <div className="px-4 py-6 text-center text-xs text-[var(--notes-text-dim)]">No versions yet</div>
                )}
                {!loadingVersions && versions.map(v => <VersionItem key={v.id} v={v} onRevert={onRevert} />)}
            </div>
        </div>
    );
}
