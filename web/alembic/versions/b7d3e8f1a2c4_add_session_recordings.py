"""add terminal_session_recordings table

Revision ID: b7d3e8f1a2c4
Revises: 6cf65b9ca525
Create Date: 2026-03-19 18:30:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7d3e8f1a2c4"
down_revision: str | Sequence[str] | None = "6cf65b9ca525"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create terminal_session_recordings table."""
    op.execute("""
        CREATE TABLE IF NOT EXISTS terminal_session_recordings (
            id SERIAL PRIMARY KEY,
            session_id UUID NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            stopped_at TIMESTAMPTZ,
            size_bytes BIGINT DEFAULT 0,
            event_count INTEGER DEFAULT 0,
            cols INTEGER,
            rows INTEGER
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_session_recordings_session_id
        ON terminal_session_recordings(session_id)
    """)


def downgrade() -> None:
    """Drop terminal_session_recordings table."""
    op.execute("DROP TABLE IF EXISTS terminal_session_recordings")
