"""add agent_tools table and drop mode check constraints

Creates the agent_tools table for CRUD-able CLI agent tools, seeds Claude Code
as the default tool, and drops the CHECK constraints on mode columns so they
can accept any agent tool slug (not just 'shell'|'claude').

Revision ID: a0cb935635d0
Revises: a1b2c3d4e5f6
Create Date: 2026-02-26 09:27:16.560843

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a0cb935635d0"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _create_agent_tools_table() -> None:
    """Create the agent_tools table and its indexes."""
    op.execute("""
        CREATE TABLE IF NOT EXISTS agent_tools (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name            VARCHAR(100) NOT NULL,
            slug            VARCHAR(50) NOT NULL UNIQUE,
            command         TEXT NOT NULL,
            process_name    VARCHAR(100) NOT NULL,
            description     TEXT,
            color           VARCHAR(20),
            display_order   INTEGER NOT NULL DEFAULT 0,
            is_default      BOOLEAN NOT NULL DEFAULT false,
            enabled         BOOLEAN NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        );
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_agent_tools_enabled
        ON agent_tools(enabled) WHERE enabled = true;
    """)


def _seed_agent_tools() -> None:
    """Seed common agent tools with Claude Code as the default."""
    op.execute("""
        INSERT INTO agent_tools (name, slug, command, process_name, description, is_default, display_order, color)
        VALUES
            ('Claude Code', 'claude', 'claude --dangerously-skip-permissions', 'claude', 'Anthropic Claude coding agent', true, 0, '#00FF9F'),
            ('OpenCode', 'opencode', 'opencode', 'opencode', 'AI coding assistant with TUI', false, 1, '#7C3AED'),
            ('Gemini CLI', 'gemini', 'gemini', 'gemini', 'Google Gemini coding agent', false, 2, '#4285F4'),
            ('Codex', 'codex', 'codex', 'codex', 'OpenAI Codex coding agent', false, 3, '#10A37F')
        ON CONFLICT (slug) DO NOTHING;
    """)


def _drop_mode_check_constraints() -> None:
    """Drop CHECK constraints on mode columns so they accept any slug."""
    op.execute("""
        ALTER TABLE aterm_sessions DROP CONSTRAINT IF EXISTS aterm_sessions_mode_check;
    """)
    op.execute("""
        ALTER TABLE aterm_panes DROP CONSTRAINT IF EXISTS aterm_panes_active_mode_check;
    """)
    op.execute("""
        ALTER TABLE aterm_project_settings DROP CONSTRAINT IF EXISTS aterm_project_settings_active_mode_check;
    """)


def _restore_mode_check_constraints() -> None:
    """Restore CHECK constraints (only valid if all data is 'shell' or 'claude')."""
    # Clean up any non-standard modes before restoring constraints
    op.execute("""
        UPDATE aterm_sessions SET mode = 'shell' WHERE mode NOT IN ('shell', 'claude');
    """)
    op.execute("""
        UPDATE aterm_panes SET active_mode = 'shell' WHERE active_mode NOT IN ('shell', 'claude');
    """)
    op.execute("""
        UPDATE aterm_project_settings SET active_mode = 'shell' WHERE active_mode NOT IN ('shell', 'claude');
    """)
    op.execute("""
        ALTER TABLE aterm_sessions
        ADD CONSTRAINT aterm_sessions_mode_check
        CHECK (mode IN ('shell', 'claude'));
    """)
    op.execute("""
        ALTER TABLE aterm_panes
        ADD CONSTRAINT aterm_panes_active_mode_check
        CHECK (active_mode IN ('shell', 'claude'));
    """)
    op.execute("""
        ALTER TABLE aterm_project_settings
        ADD CONSTRAINT aterm_project_settings_active_mode_check
        CHECK (active_mode IN ('shell', 'claude'));
    """)


def _drop_agent_tools_table() -> None:
    """Drop the agent_tools indexes and table."""
    op.execute("DROP INDEX IF EXISTS idx_agent_tools_enabled;")
    op.execute("DROP TABLE IF EXISTS agent_tools;")


def upgrade() -> None:
    """Create agent_tools table, seed Claude Code, drop mode CHECK constraints."""
    _create_agent_tools_table()
    _seed_agent_tools()
    _drop_mode_check_constraints()


def downgrade() -> None:
    """Restore CHECK constraints, drop agent_tools table."""
    _restore_mode_check_constraints()
    _drop_agent_tools_table()
