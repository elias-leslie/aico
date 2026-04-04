"""Alembic migration environment configuration for Terminal.

Terminal uses raw SQL queries (psycopg) without SQLAlchemy models,
so we don't use autogenerate. Migrations are written manually.

Terminal shares the summitflow database, so we use a separate
version table (terminal_alembic_version) to avoid conflicts.
"""

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context
from terminal.config import DATABASE_URL as _APP_DB_URL

assert _APP_DB_URL, "DATABASE_URL env var required (set in repo .env.local, .env, or environment)"

config = context.config

# Terminal uses psycopg v3 (not psycopg2), so use the +psycopg dialect
_db_url = _APP_DB_URL.replace("postgresql://", "postgresql+psycopg://", 1)
config.set_main_option("sqlalchemy.url", _db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None

VERSION_TABLE = "terminal_alembic_version"


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table=VERSION_TABLE,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table=VERSION_TABLE,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
