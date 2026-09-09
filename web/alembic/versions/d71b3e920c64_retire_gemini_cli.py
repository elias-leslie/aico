"""Retire the Gemini CLI launch entry; preserve session history.

Revision ID: d71b3e920c64
Revises: c6d910f4a82b
"""

from alembic import op

revision = "d71b3e920c64"
down_revision = "c6d910f4a82b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DELETE FROM agent_tools WHERE slug = 'gemini'")


def downgrade() -> None:
    op.execute("""
        INSERT INTO agent_tools (name, slug, command, process_name, description,
                                 display_order, color, enabled, is_default)
        VALUES ('Gemini CLI', 'gemini', 'gemini', 'gemini',
                'Google Gemini coding agent', 2, '#4285F4', true, false)
        ON CONFLICT (slug) DO NOTHING
    """)
