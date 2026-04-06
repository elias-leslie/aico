"""rename aterm schema to a_term

Revision ID: 5c128471688d
Revises: 363fd0ed6429
Create Date: 2026-04-06 13:05:07.435785

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5c128471688d"
down_revision: str | Sequence[str] | None = "363fd0ed6429"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_RENAMES = [
    ("aterm_sessions", "a_term_sessions"),
    ("aterm_project_settings", "a_term_project_settings"),
    ("aterm_panes", "a_term_panes"),
    ("aterm_session_recordings", "a_term_session_recordings"),
    ("aterm_maintenance_runs", "a_term_maintenance_runs"),
]

INDEX_RENAMES = [
    ("idx_aterm_sessions_alive", "idx_a_term_sessions_alive"),
    ("idx_aterm_sessions_project", "idx_a_term_sessions_project"),
    ("idx_aterm_sessions_pane_id", "idx_a_term_sessions_pane_id"),
    (
        "idx_aterm_sessions_project_mode_alive_created",
        "idx_a_term_sessions_project_mode_alive_created",
    ),
    ("idx_aterm_sessions_dead_last_accessed", "idx_a_term_sessions_dead_last_accessed"),
    ("idx_aterm_sessions_display_order_created", "idx_a_term_sessions_display_order_created"),
    ("idx_aterm_sessions_user", "idx_a_term_sessions_user"),
    ("idx_aterm_panes_project_id", "idx_a_term_panes_project_id"),
    ("idx_aterm_panes_order", "idx_a_term_panes_order"),
    ("idx_aterm_panes_detached_order", "idx_a_term_panes_detached_order"),
    ("idx_aterm_project_settings_display_order", "idx_a_term_project_settings_display_order"),
    ("idx_aterm_maintenance_runs_started_at", "idx_a_term_maintenance_runs_started_at"),
    (
        "idx_aterm_maintenance_runs_status_started_at",
        "idx_a_term_maintenance_runs_status_started_at",
    ),
    ("idx_aterm_session_recordings_session_id", "idx_a_term_session_recordings_session_id"),
]

SEQUENCE_RENAMES = [
    ("aterm_session_recordings_id_seq", "a_term_session_recordings_id_seq"),
]

CONSTRAINT_RENAMES = {
    "a_term_sessions": [
        ("aterm_sessions_pkey", "a_term_sessions_pkey"),
        ("aterm_sessions_pane_id_fkey", "a_term_sessions_pane_id_fkey"),
        ("ck_aterm_sessions_claude_state", "ck_a_term_sessions_claude_state"),
    ],
    "a_term_panes": [
        ("aterm_panes_pkey", "a_term_panes_pkey"),
        ("ck_aterm_panes_pane_type", "ck_a_term_panes_pane_type"),
    ],
    "a_term_project_settings": [
        ("aterm_project_settings_pkey", "a_term_project_settings_pkey"),
    ],
    "a_term_session_recordings": [
        ("aterm_session_recordings_pkey", "a_term_session_recordings_pkey"),
        (
            "aterm_session_recordings_session_id_fkey",
            "a_term_session_recordings_session_id_fkey",
        ),
    ],
    "a_term_maintenance_runs": [
        ("aterm_maintenance_runs_pkey", "a_term_maintenance_runs_pkey"),
        ("ck_aterm_maintenance_runs_status", "ck_a_term_maintenance_runs_status"),
    ],
}

DUPLICATE_CONSTRAINTS = {
    "a_term_sessions": ["ck_terminal_sessions_claude_state"],
    "a_term_panes": ["ck_terminal_panes_pane_type"],
    "a_term_maintenance_runs": ["ck_maintenance_runs_status"],
}

TABLE_COMMENTS = {
    "a_term_project_settings": "A-Term settings per project",
    "a_term_panes": "A-Term panes - containers for 1-2 sessions (shell/agent)",
}


def _rename_table(old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old_name}') IS NOT NULL
               AND to_regclass('public.{new_name}') IS NULL THEN
                EXECUTE 'ALTER TABLE {old_name} RENAME TO {new_name}';
            END IF;
        END $$;
        """
    )


def _rename_index(old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old_name}') IS NOT NULL
               AND to_regclass('public.{new_name}') IS NULL THEN
                EXECUTE 'ALTER INDEX {old_name} RENAME TO {new_name}';
            END IF;
        END $$;
        """
    )


def _rename_sequence(old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old_name}') IS NOT NULL
               AND to_regclass('public.{new_name}') IS NULL THEN
                EXECUTE 'ALTER SEQUENCE {old_name} RENAME TO {new_name}';
            END IF;
        END $$;
        """
    )


def _rename_constraint(table_name: str, old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{table_name}') IS NOT NULL
               AND EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{old_name}'
                      AND conrelid = to_regclass('public.{table_name}')
               )
               AND NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{new_name}'
                      AND conrelid = to_regclass('public.{table_name}')
               ) THEN
                EXECUTE 'ALTER TABLE {table_name} RENAME CONSTRAINT {old_name} TO {new_name}';
            END IF;
        END $$;
        """
    )


def _drop_constraint(table_name: str, constraint_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{table_name}') IS NOT NULL
               AND EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{constraint_name}'
                      AND conrelid = to_regclass('public.{table_name}')
               ) THEN
                EXECUTE 'ALTER TABLE {table_name} DROP CONSTRAINT {constraint_name}';
            END IF;
        END $$;
        """
    )


def _set_table_comments() -> None:
    for table_name, comment in TABLE_COMMENTS.items():
        op.execute(f"COMMENT ON TABLE {table_name} IS '{comment}';")


def _set_recordings_sequence_default() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF to_regclass('public.a_term_session_recordings') IS NOT NULL
               AND to_regclass('public.a_term_session_recordings_id_seq') IS NOT NULL THEN
                ALTER TABLE a_term_session_recordings
                ALTER COLUMN id SET DEFAULT nextval('a_term_session_recordings_id_seq'::regclass);
                ALTER SEQUENCE a_term_session_recordings_id_seq
                OWNED BY a_term_session_recordings.id;
            END IF;
        END $$;
        """
    )


def upgrade() -> None:
    """Rename legacy aterm-prefixed schema objects to a_term-prefixed names."""
    for old_name, new_name in TABLE_RENAMES:
        _rename_table(old_name, new_name)

    for old_name, new_name in INDEX_RENAMES:
        _rename_index(old_name, new_name)

    for old_name, new_name in SEQUENCE_RENAMES:
        _rename_sequence(old_name, new_name)

    for table_name, renames in CONSTRAINT_RENAMES.items():
        for old_name, new_name in renames:
            _rename_constraint(table_name, old_name, new_name)

    for table_name, constraints in DUPLICATE_CONSTRAINTS.items():
        for constraint_name in constraints:
            _drop_constraint(table_name, constraint_name)

    _set_recordings_sequence_default()
    _set_table_comments()


def downgrade() -> None:
    """Rename a_term-prefixed schema objects back to aterm-prefixed names."""
    for table_name, constraints in DUPLICATE_CONSTRAINTS.items():
        for constraint_name in constraints:
            _drop_constraint(table_name, constraint_name)

    for table_name, renames in CONSTRAINT_RENAMES.items():
        for old_name, new_name in reversed(renames):
            _rename_constraint(table_name, new_name, old_name)

    for old_name, new_name in reversed(SEQUENCE_RENAMES):
        _rename_sequence(new_name, old_name)

    for old_name, new_name in reversed(INDEX_RENAMES):
        _rename_index(new_name, old_name)

    for old_name, new_name in reversed(TABLE_RENAMES):
        _rename_table(new_name, old_name)
