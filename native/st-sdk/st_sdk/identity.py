"""Compatibility helper for local, same-user Aico HTTP clients."""


def token_headers() -> dict[str, str]:
    """No implicit credentials: each remote project's client owns its identity."""
    return {}
