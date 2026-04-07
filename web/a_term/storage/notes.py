"""Public note storage facade for A-Term."""

from .notes_query import count_notes, get_note, list_notes, list_project_scopes, list_tags
from .notes_write import create_note, delete_note, update_note

__all__ = [
    "count_notes",
    "create_note",
    "delete_note",
    "get_note",
    "list_notes",
    "list_project_scopes",
    "list_tags",
    "update_note",
]
