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
| `GET /v1/roots` | Forwarded as `GET /v1/roots?origin=a-term`: only roots requested through A-Term, with Tether's `owner: "a-term"`. A-Term adds its `position` block to the list and to each descriptor. |
| `POST /v1/roots` | Forwarded with `origin: "a-term"` and an `aTermSessionId` (a new UUID unless the caller sent one); a body naming another origin is `400 invalid_body`. Neither field is part of Tether's digest. On `200`/`202` for a running or pending root, A-Term links the root's session (`hostIdentity`) to a new detached pane so it can be shown later. |
| `GET /v1/roots/:requestId` | Forwarded, with the `position` block added. |
| `POST /v1/roots/:requestId/show` | Answered by A-Term: generation-fenced against Tether's descriptor, then the root's pane is brought into the layout (created first if missing). Browser focus is never implied. |
| `POST /v1/roots/:requestId/position` | Generation-checked, then `503 position_unavailable`: the browser grid has no pixel window bounds. |
| `POST /v1/roots/:requestId/title` | Forwarded. Tether validates the label, and with no Aico GUI connected renames the session under its lifecycle lock, fenced on the exact running generation. With an Aico GUI connected, Tether applies the title through the GUI and renames only if the GUI applies it. |
| `POST /v1/roots/:requestId/end` | Forwarded. Tether retires the session and keeps the tombstone. |
| `POST /v1/roots/:requestId/send` | Forwarded. Tether answers `503 directed_delivery_unavailable`. |
| `GET` and `POST /v1/roots/:requestId/admin` | Forwarded. |

Status codes and error bodies are Tether's: `409 request_conflict`,
`409 stale_generation`, `409 workload_unavailable`, `410 ended`, and so on.
When Tether cannot be reached every route answers `503 {"error":"owner_failure"}`.

## Owner and origin

Tether stores the origin a root was requested through. On its `/v1` socket a
root's `owner` is that origin and the descriptor carries `origin`, so roots
requested here report `owner: "a-term"`, the owner SummitFlow's `a-term`
surface checks, without A-Term changing anything. (Tether's legacy Aico
sockets keep `owner: "aico"` for `st aico`.) `hostIdentity` (the 8-hex Tether
session ID), `generation`, `logicalSessionId` and `surfaceLocator` pass
through unchanged, so the identity SummitFlow retains stays stable across
reconciles. `GET /v1/roots/:requestId` and the mutations address any root by
`requestId`; a root requested through Aico reports `owner: "aico"` there.

## Migration note

A-Term's own `a_term_root_requests` table was empty at cutover, so no tombstone
moves to Tether. Roots requested through A-Term before this version have no
receipts to carry over.
