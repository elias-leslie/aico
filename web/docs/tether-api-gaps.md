# Tether API gaps found while moving A-Term onto Tether

A-Term is written against Tether's `docs/api-v1.md` as the contract. These are
the places where the contract does not cover something A-Term needs, and how
A-Term works around each one today. Each item names the smallest additive v1
change that would remove the workaround. None of them blocks the cutover.

## 1. `POST /v1/roots` cannot say which app requested a root

The body has no `origin` (or `aTermSessionId`), and unknown fields are
rejected. A root requested through A-Term's `/v1/roots` therefore gets the
same origin as one requested through Aico.

- Workaround: A-Term forwards the body unchanged and links the resulting
  session (`hostIdentity`) to a detached A-Term pane itself.
- Wanted: optional `origin` on `POST /v1/roots`, stored on the root's session.

## 2. Root descriptors carry no origin, and the list has no filter

`GET /v1/roots` returns every root. SummitFlow's `a-term` surface therefore
lists roots requested through Aico too.

- Workaround: none needed for correctness (SummitFlow addresses roots by
  `requestId`), but the list is wider than before.
- Wanted: `origin` on root descriptors and `GET /v1/roots?origin=`.

## 3. Root `owner` is always `"aico"`

SummitFlow's `a-term` surface requires `owner == "a-term"`.

- Workaround: A-Term's proxy rewrites `owner` to `"a-term"` and adds its
  `position` block; every identity field passes through unchanged.
- Wanted: nothing, if A-Term keeps the proxy. Otherwise an owner that follows
  the requesting surface.

## 4. Root `show`, `position` and `title` need the Aico GUI

They are forwarded to the Aico GUI channel and answer `503 gui_unavailable`
without it. A-Term's views are browser panes, not Aico windows.

- Workaround: A-Term answers `show` (bring its pane into the layout) and
  `position` (`503 position_unavailable`) itself after checking the generation
  against Tether's descriptor, and applies `title` with
  `PATCH /v1/sessions/:hostIdentity {generation, name}`. That rename is not
  atomic with any GUI view change, which is fine for A-Term because its
  views read the name on refresh.
- Wanted: a documented rule that `title` renames without a GUI when the root
  was requested by a non-GUI origin, or per-app view-command routing.

## 5. No bulk import for agent tools

There is no import route for A-Term's old `agent_tools` rows.

- Workaround: `a-term migrate-from-postgres --apply` writes the rows as JSON;
  `a-term import-tools FILE --apply` creates missing tools with
  `POST /v1/tools` and, only with `--update-existing`, patches differing fields
  with `PATCH /v1/tools/:ref`. It is not atomic across tools. At cutover all
  four A-Term tools already exist in Tether's seed (`claude` as the alias of
  `claude-code`), and the commands match except `pi` (A-Term ran bare `pi`;
  Tether seeds `pi --approve`). The default run reports that and any display
  differences and changes nothing.
- Wanted: `POST /v1/tools/import` taking a list, applied in one transaction,
  with a dry-run flag.

## 6. No route to register a local project

Projects are read-only over the API. A-Term's "Register project" (only offered
when the source is `local`) writes `~/.config/tether/projects.json`
(`TETHER_PROJECTS_FILE` overrides it) atomically and then calls
`GET /v1/projects?refresh=1`.

- Gaps: the contract does not say that `refresh=1` re-reads the local file, or
  who owns that file's format beyond `{id, name?, root}`.
- Wanted: `POST /v1/projects` for the local source (`403` when the source is
  SummitFlow), plus a `projects.changed` event when the file changes.

## 7. `resize-claim` refusal reasons are not enumerated

`{applied: false, reason}` has no listed reasons. A-Term claims right after its
PTY starts `tmux attach`, so the client may not be attached yet.

- Workaround: A-Term retries a refused claim at most 5 times, 100 ms apart,
  re-reads the generation once on `409 stale_generation`, and otherwise gives
  up quietly. A refused claim never affects the view's own PTY size.
- Wanted: stable reason codes, at least `client_not_attached` (retryable),
  `window_linked` and `status_row` (permanent).

## 8. Attach `env`: complete environment or overrides?

`GET /v1/sessions/:id/attach` returns `env` described as "the client
environment". A-Term does not know whether to use it as the whole environment.

- Workaround: A-Term starts from its own environment, applies Tether's `env`
  on top, and removes `TMUX`, `TMUX_PANE` and `NO_COLOR` afterwards.
- Wanted: say whether `env` is complete or a set of overrides.

## 9. The Tether CLI cannot create or attach sessions

`tether` has `sessions`, `roots`, `tools`, `projects`, `doctor` and `version`,
but no way to start a session or attach a terminal to one.

- Workaround: `tsession` (and `tclaude`/`tcodex`) do both through the API:
  `POST /v1/sessions` with `origin: "a-term"`, then the attach argv, with
  switch-client inside the same tmux server and a nested attach (with `TMUX`
  unset, after a notice) inside a different one.
- Wanted: `tether attach <id>` and `tether new --tool --project`, so other
  terminals need no A-Term code.

## 10. No import for root-request tombstones

A-Term's `a_term_root_requests` table was empty at cutover, so nothing was
lost. A future migration from another root owner would need an import route
that keeps tombstones (`requestId` + digest, ended).
