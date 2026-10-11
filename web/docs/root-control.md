# Local root workloads

Tether owns root workloads now. A-Term keeps `/v1/roots` on its existing
service (`http://127.0.0.1:8002`) so SummitFlow fleet's `a-term` surface keeps
working unchanged, but A-Term no longer creates, launches, fences or retires
roots itself. Each route forwards to Tether's root contract
(`/v1/roots` in Tether's `docs/api-v1.md`, which is Aico's contract moved
unchanged: request IDs, digest, tombstones, the Codex resume adapter and every
validation rule).

## Guard

The routes stay where they were and keep their guard:

- loopback clients only (`403 local_only`);
- a browser `Origin`, if sent, must be one of the configured CORS origins
  (`403 origin_not_allowed`);
- the app's normal authentication middleware applies (these routes are not
  under `/api/internal/` and are never exempt);
- mutating bodies must be `application/json`, at most 128 KiB.

No Tether route is exposed under `/api/*`.

## What A-Term forwards and what it answers itself

| Route | Handling |
| --- | --- |
| `GET /v1/roots` | Forwarded. The list and each descriptor are presented with `owner: "a-term"` and A-Term's `position` block. |
| `POST /v1/roots` | Forwarded as is. On `200`/`202` for a running or pending root, A-Term links the root's session (`hostIdentity`) to a new detached pane so it can be shown later. |
| `GET /v1/roots/:requestId` | Forwarded, presented as above. |
| `POST /v1/roots/:requestId/show` | Answered by A-Term: generation-fenced against Tether's descriptor, then the root's pane is brought into the layout (created first if missing). Browser focus is never implied. |
| `POST /v1/roots/:requestId/position` | Generation-checked, then `503 position_unavailable`: the browser grid has no pixel window bounds. |
| `POST /v1/roots/:requestId/title` | Generation-fenced and label-validated by A-Term (1–160 UTF-8 bytes after trimming, no control characters), then applied with Tether's session rename. Tether's own root title route needs the Aico GUI; the rename does not. |
| `POST /v1/roots/:requestId/end` | Forwarded. Tether retires the session and keeps the tombstone. |
| `POST /v1/roots/:requestId/send` | Forwarded. Tether answers `503 directed_delivery_unavailable`. |
| `GET` and `POST /v1/roots/:requestId/admin` | Forwarded. |

Status codes and error bodies are Tether's: `409 request_conflict`,
`409 stale_generation`, `409 workload_unavailable`, `410 ended`, and so on.
When Tether cannot be reached every route answers `503 {"error":"owner_failure"}`.

## Why `owner` is rewritten

Tether reports `owner: "aico"` on root descriptors for compatibility with
`st aico` and SummitFlow's `aico` surface. SummitFlow's `a-term` surface
checks `owner == "a-term"`, so A-Term presents the same descriptor under its
own name. `hostIdentity` (the 8-hex Tether session ID), `generation`,
`logicalSessionId` and `surfaceLocator` pass through unchanged, so the identity
SummitFlow retains stays stable across reconciles.

Tether's root list does not say which app a root was requested through
(see `docs/tether-api-gaps.md`), so this surface lists every root Tether holds.

## Migration note

A-Term's own `a_term_root_requests` table was empty at cutover, so no tombstone
moves to Tether. Roots requested through A-Term before this version have no
receipts to carry over.
