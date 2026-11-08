# Agent shares

An agent files files, folders or a link with `tether share` (Tether's
`POST /v1/show`). A share is a link to where the files already are; nothing is
copied. It is filed quietly: no pop-up, no notice, no count. It waits in Aico
under **Files › Shared** for when you go looking.

To get you to look at something, an agent files an ask instead, and only if you
truly need to: `tether ask create "..." --file PATH` (or `--open URL` for a link).
The card shows each file with Open; a file on another linked computer says which one,
and opens there.

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
in; the files themselves are never touched. Each `tether share` publishes a
`show.requested` event with the same data, which keeps a linked host's copy of the
list current; nothing tells the owner from it. An ask's `--file` publishes none, so
another machine's list has that one only after its next link-up; the ask's card has it
all along.

## Web app

`GET /api/shows` lists Tether's shares, checked again field by field, and
Files › Shared shows them, the ones an ask attached included: the ask's card and
its web pages read the same record.

Files reads by location: `/api/files/{stat,tree,content,raw}?root=&path=`. Reads
stay inside the folder and refuse secrets and hidden folders (the same rules as
the project file browser). `raw` serves images and text inline and anything
else as a download, up to 25 MiB, with `nosniff` and a sandbox CSP. A path that
is gone answers 404, shown as "This file was moved or deleted".

File paths in the terminal (absolute, or starting with `~/`) are clickable and
open in the same viewer.
