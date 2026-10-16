# Root control

Tether owns root control and hosts its contract: the routes, the create body,
tombstones, the resume adapters, the validation rules and how the `st aico`
client relies on them. Read Tether's
[`docs/root-control.md`](https://github.com/elias-leslie/tether/blob/main/docs/root-control.md)
(in a local checkout, `../tether/docs/root-control.md`).

From Aico's side, two things matter:

- `scripts/aico-root-watch.py` is the entry SummitFlow runs for `st aico`; it
  hands over to Tether's installed copy (`TETHER_ROOT_WATCH` overrides the path).
  Keep its path.
- Show, position and title for roots and widgets arrive over Tether's GUI channel
  (`GET /v1/gui/channel`); Aico applies them to the window and its view row and
  posts the result. With no Aico connected, those routes return 503
  `gui_unavailable`.
