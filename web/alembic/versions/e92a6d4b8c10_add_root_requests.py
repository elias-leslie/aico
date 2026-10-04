"""Retain one-to-one root request receipts independently of retired sessions.

Revision ID: e92a6d4b8c10
Revises: d71b3e920c64
"""

from alembic import op

revision = "e92a6d4b8c10"
down_revision = "d71b3e920c64"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE a_term_root_requests (
            request_id VARCHAR(128) PRIMARY KEY,
            digest VARCHAR(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
            session_id UUID NOT NULL UNIQUE,
            pane_id UUID NOT NULL UNIQUE,
            logical_session_id VARCHAR(128) NOT NULL UNIQUE,
            role VARCHAR(128) NOT NULL,
            lead_root_reference VARCHAR(128),
            facet_capsule_ref VARCHAR(128),
            launch_state VARCHAR(16) NOT NULL DEFAULT 'reserved'
                CHECK (launch_state IN ('reserved', 'attempted', 'observed', 'ended')),
            generation VARCHAR(64),
            process_pid INTEGER,
            process_start_ticks VARCHAR(32),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    # No cascading foreign keys: receipts survive pane/session retirement and purge.


def downgrade() -> None:
    op.drop_table("a_term_root_requests")
