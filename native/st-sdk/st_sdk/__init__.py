"""Public, application-neutral helpers for trusted ST command extensions."""

from importlib import import_module
from typing import Any

from .usage import UsageSpec, usage

_EXPORTS = {
    "STClient": "client",
    "Config": "config",
    "get_agent_hub_url": "config",
    "get_api_base": "config",
    "get_config": "config",
    "get_config_optional": "config",
    "OutputContext": "context",
    "APIError": "http",
    "BaseHTTPClient": "http",
    "describe_app": "runtime",
    "initialize_context": "runtime",
    "run_app": "runtime",
}


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{_EXPORTS[name]}", __name__), name)
    globals()[name] = value
    return value

__all__ = [
    "APIError",
    "BaseHTTPClient",
    "Config",
    "OutputContext",
    "STClient",
    "UsageSpec",
    "describe_app",
    "get_agent_hub_url",
    "get_api_base",
    "get_config",
    "get_config_optional",
    "initialize_context",
    "run_app",
    "usage",
]
