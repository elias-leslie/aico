"""Structured logging configuration using structlog.

Configures structured JSON logging with processors, formatters, and file
rotation for production observability.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
from pathlib import Path
from typing import ClassVar

import structlog
from pythonjsonlogger import json


def _parse_log_level(level_str: str | None) -> int:
    """Parse log level string to logging constant (defaults to INFO)."""
    if not level_str:
        return logging.INFO
    level_map = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARN": logging.WARNING,
        "WARNING": logging.WARNING,
        "ERROR": logging.ERROR,
        "CRITICAL": logging.CRITICAL,
    }
    return level_map.get(level_str.upper(), logging.INFO)


class SyslogPrefixFormatter(logging.Formatter):
    """Formatter that adds syslog priority prefixes for systemd journald.

    Systemd parses "<priority>message" prefixes to set the PRIORITY field in
    journald instead of defaulting all stdout to INFO (priority 6).

    Priority mapping (RFC 5424): 2=Critical, 3=Error, 4=Warning,
    6=Informational, 7=Debug.
    """

    PRIORITY_MAP: ClassVar[dict[int, int]] = {
        logging.CRITICAL: 2,
        logging.ERROR: 3,
        logging.WARNING: 4,
        logging.INFO: 6,
        logging.DEBUG: 7,
    }

    def format(self, record: logging.LogRecord) -> str:
        """Format log record with syslog priority prefix."""
        priority = self.PRIORITY_MAP.get(record.levelno, 6)
        return f"<{priority}>{super().format(record)}"


def _create_file_handler(
    log_dir: str, log_file: str, log_level: int
) -> logging.Handler:
    """Create a rotating JSON file handler."""
    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)

    json_formatter = json.JsonFormatter(
        "%(timestamp)s %(level)s %(name)s %(message)s %(pathname)s %(lineno)d",
        rename_fields={
            "levelname": "level",
            "name": "logger",
            "pathname": "file",
            "lineno": "line",
        },
    )

    handler = logging.handlers.TimedRotatingFileHandler(
        filename=str(log_path / log_file),
        when="midnight",
        interval=1,
        backupCount=30,
        encoding="utf-8",
    )
    handler.setLevel(log_level)
    handler.setFormatter(json_formatter)
    return handler


def _create_console_handler(log_level: int) -> logging.Handler:
    """Create a stdout handler with syslog prefix formatting."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(log_level)
    handler.setFormatter(
        SyslogPrefixFormatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
    return handler


def _configure_structlog() -> None:
    """Configure structlog processors and logger factory."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.filter_by_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


def configure_logging(
    log_dir: str = "logs", log_file: str = "aterm.log"
) -> None:
    """Configure structured logging with JSON output.

    Reads log level from LOG_LEVEL env var (default INFO). File logging is
    skipped under systemd (INVOCATION_ID set) since the journal captures
    stdout/stderr automatically.
    """
    log_level = _parse_log_level(os.getenv("LOG_LEVEL"))
    log_dir = os.getenv("LOG_DIR", log_dir)
    log_file = os.getenv("LOG_FILE", log_file)
    running_under_systemd = bool(os.getenv("INVOCATION_ID"))

    handlers: list[logging.Handler] = []
    if not running_under_systemd:
        handlers.append(_create_file_handler(log_dir, log_file, log_level))
    handlers.append(_create_console_handler(log_level))

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers = []
    for handler in handlers:
        root_logger.addHandler(handler)

    _configure_structlog()


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Get a structured logger by name (typically __name__)."""
    return structlog.get_logger(name)
