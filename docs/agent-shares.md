# Agent shares

An agent hands you files, folders or a link with `tether share` (Tether's
`POST /v1/show`). A share is a link to where the files already are; nothing is
copied. You open it in Aico under **Files › Shared**.

```
tether share /srv/out/report.md ./prompt.md --title "Report and prompt"
tether share --url https://example.com/run/42
```

Relative paths are taken from the current folder. The session comes from
`AICO_WIDGET_ID`, so the share says which session made it.

## Tether

Tether checks each path exists and is a file or folder, and records its real
path (symlinks resolved, duplicates dropped; a folder ends in `/`). Up to 20
paths per share. Shares live in Tether's database (`shares`, schema v11) and
are listed by `GET /v1/shares` (newest 200, oldest first). Records older than
`TETHER_SHARE_RETENTION_DAYS` (default 30) are dropped when a new share comes
in; the files themselves are never touched. Each share publishes a
`show.requested` event with the same data.

Shares are accepted only from the owner's default Tether, `tether@default`
(`$XDG_RUNTIME_DIR/tether/default/control.sock`). Agents run as the owner, so
`tether share` from any session reaches it.

## Web app

`GET /api/shows` lists Tether's shares, checked again field by field;
`?since=<id>` returns those after that ID (an unknown ID returns the whole list).
The page polls every ten seconds while visible. A notice pops up for each new
share; on opening the app, up to three made since it was last open pop up too.
**Open** shows the share in Files › Shared. A link share offers Copy only.

Files reads by location: `/api/files/{stat,tree,content,raw}?root=&path=`. Reads
stay inside the folder and refuse secrets and hidden folders (the same rules as
the project file browser). `raw` serves images and text inline and anything
else as a download, up to 25 MiB, with `nosniff` and a sandbox CSP. A path that
is gone answers 404, shown as "This file was moved or deleted".

File paths in the terminal (absolute, or starting with `~/`) are clickable and
open in the same viewer.

Each new share runs `nightshift push` (ten-second timeout, key `show:<id>`). Its
link `https://<hosts.browser_frontend>/?show=<id>` opens the share in Files.

## Desktop

The desktop shows a notice with **Open**, which opens the share in the web app,
or a link share's URL with **Copy**.
