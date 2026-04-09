import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createNotesApi } from './api';
import type { NotesCapabilities, NotesConfig, NotesScopeOption } from './types';

interface NotesContextValue extends NotesConfig {
    api: ReturnType<typeof createNotesApi>;
    canInject: boolean;
    capabilities: NotesCapabilities;
    scopeOptions: NotesScopeOption[];
    getScopeLabel: (scope: string) => string;
}

const NotesContext = createContext<NotesContextValue | null>(null);

const DEFAULT_CAPABILITIES: NotesCapabilities = {
    title_generation: true,
    formatting: false,
    prompt_refinement: false,
};

type NotesThemeStyle = CSSProperties & Record<`--${string}`, string>;

export const NOTES_THEME_STYLE: NotesThemeStyle = {
    '--notes-bg': 'var(--term-bg-surface, #0f172a)',
    '--notes-bg-deep': 'var(--term-bg-deep, #081018)',
    '--notes-bg-elevated': 'var(--term-bg-elevated, #16202a)',
    '--notes-bg-glass': 'var(--term-bg-elevated, #16202a)',
    '--notes-bg-overlay': 'var(--term-bg-surface, #0f172a)',
    '--notes-bg-soft': 'var(--term-surface-soft, rgba(255, 255, 255, 0.05))',
    '--notes-bg-soft-hover': 'var(--term-surface-soft-hover, rgba(255, 255, 255, 0.1))',
    '--notes-border': 'var(--term-border, #334155)',
    '--notes-border-strong': 'var(--term-border-active, #4b6377)',
    '--notes-text-primary': 'var(--term-text-primary, #e2e8f0)',
    '--notes-text-muted': 'var(--term-text-muted, #94a3b8)',
    '--notes-text-dim': 'var(--term-text-dim, rgba(230, 237, 243, 0.58))',
    '--notes-text-faint': 'var(--term-text-faint, rgba(230, 237, 243, 0.36))',
    '--notes-accent': 'var(--term-accent, #00ff9f)',
    '--notes-accent-soft': 'var(--term-accent-soft, rgba(0, 255, 159, 0.15))',
    '--notes-accent-border': 'var(--term-accent-border, rgba(0, 255, 159, 0.35))',
    '--notes-success': 'var(--term-success, #3fb950)',
    '--notes-success-soft': 'color-mix(in srgb, var(--notes-success) 15%, transparent)',
    '--notes-success-border': 'color-mix(in srgb, var(--notes-success) 35%, transparent)',
    '--notes-warning': 'var(--term-warning, #d29922)',
    '--notes-warning-soft': 'color-mix(in srgb, var(--notes-warning) 15%, transparent)',
    '--notes-warning-border': 'color-mix(in srgb, var(--notes-warning) 30%, transparent)',
    '--notes-danger': 'var(--term-danger, #f85149)',
    '--notes-danger-soft': 'var(--term-danger-soft, rgba(248, 81, 73, 0.12))',
    '--notes-danger-border': 'var(--term-danger-border, rgba(248, 81, 73, 0.36))',
    '--notes-shadow': 'var(--term-shadow-dropdown, 0 18px 36px rgba(0, 0, 0, 0.42))',
    '--notes-font-display': 'var(--font-ui, inherit)',
};

export const NOTES_PROSE_CLASS_NAME =
    'prose prose-sm max-w-none [--tw-prose-body:var(--notes-text-muted)] [--tw-prose-headings:var(--notes-text-primary)] [--tw-prose-lead:var(--notes-text-muted)] [--tw-prose-links:var(--notes-accent)] [--tw-prose-bold:var(--notes-text-primary)] [--tw-prose-counters:var(--notes-text-dim)] [--tw-prose-bullets:var(--notes-text-dim)] [--tw-prose-hr:var(--notes-border)] [--tw-prose-quotes:var(--notes-text-primary)] [--tw-prose-quote-borders:var(--notes-border)] [--tw-prose-captions:var(--notes-text-faint)] [--tw-prose-kbd:var(--notes-text-primary)] [--tw-prose-kbd-shadows:var(--notes-border)] [--tw-prose-code:var(--notes-warning)] [--tw-prose-pre-code:var(--notes-text-primary)] [--tw-prose-pre-bg:var(--notes-bg-deep)] [--tw-prose-th-borders:var(--notes-border)] [--tw-prose-td-borders:var(--notes-border)]';

export function useNotesContext(): NotesContextValue {
    const ctx = useContext(NotesContext);
    if (!ctx) throw new Error('useNotesContext must be used within NotesProvider');
    return ctx;
}

interface NotesProviderProps extends NotesConfig {
    children: ReactNode;
}

export function NotesProvider({ apiPrefix, projectScope, onInject, children }: NotesProviderProps) {
    const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);
    const [scopeOptions, setScopeOptions] = useState<NotesScopeOption[]>([]);
    const api = useMemo(() => createNotesApi(apiPrefix), [apiPrefix]);

    useEffect(() => {
        let cancelled = false;
        api.capabilities()
            .then(next => {
                if (!cancelled) setCapabilities(next);
            })
            .catch(() => {
                if (!cancelled) setCapabilities(DEFAULT_CAPABILITIES);
            });
        return () => {
            cancelled = true;
        };
    }, [api]);

    useEffect(() => {
        let cancelled = false;
        api.scopes()
            .then(next => {
                if (!cancelled) setScopeOptions(next);
            })
            .catch(() => {
                if (!cancelled) setScopeOptions([]);
            });
        return () => {
            cancelled = true;
        };
    }, [api]);

    const value = useMemo<NotesContextValue>(() => ({
        apiPrefix,
        projectScope,
        onInject,
        canInject: typeof onInject === 'function',
        api,
        capabilities,
        scopeOptions,
        getScopeLabel: (scope: string) => {
            const option = scopeOptions.find(candidate => candidate.value === scope);
            return option?.label ?? scope;
        },
    }), [apiPrefix, api, capabilities, projectScope, onInject, scopeOptions]);

    return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}
