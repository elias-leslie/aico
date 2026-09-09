"""Retire OpenCode, Hermes CLI, and Claude GPT launch entries.

Revision ID: c6d910f4a82b
Revises: b4c7d9e1f203

Session histories store mode strings independently and remain intact. Export
custom tool configuration before upgrading; downgrade restores shipped defaults.
"""

from alembic import op

revision = "c6d910f4a82b"
down_revision = "b4c7d9e1f203"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DELETE FROM agent_tools WHERE slug IN ('opencode', 'hermes', 'claude-gpt')")


def downgrade() -> None:
    op.execute("""
        INSERT INTO agent_tools (name, slug, command, process_name, description,
                                 display_order, color, enabled, is_default)
        VALUES
            ('OpenCode', 'opencode', 'opencode', 'opencode',
             'AI coding assistant with TUI', 1, '#7C3AED', true, false),
            ('Hermes', 'hermes', 'hermes', 'hermes',
             'Nous Hermes multi-channel coding agent', 4, '#F59E0B', true, false),
            ('Claude GPT', 'claude-gpt', 'claude-gpt --dangerously-skip-permissions', 'claude',
             'Claude Code powered by GPT-5.6 through the local Codex proxy', 1, '#10A37F', true, false)
        ON CONFLICT (slug) DO NOTHING
    """)
