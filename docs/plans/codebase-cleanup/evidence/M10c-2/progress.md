# M10c-2a verification record

Scope: brief M10c-2a at 23937172. Existing source/target configuration was exported once with read-only SQL: 65 source records, 2 backend records, 2 external checks. Keys/passwords/Drive auth were not read or printed. Backup excludes were copied verbatim. Existing btrbk configuration remains the retention authority for the native T7 copy.

Baseline acceptance: passed for pinned 23937172237deb969d2f95ea66d19823715a944f; receipt b22733791fe46868a33e9ee3b0ba9924afb88cd7dff19f4862cfed834a7488d1. An earlier unpinned run stopped because concurrent work changed its inputs.

Coordinator-expanded scope: the owner approved a new CT190-only append key and password and independent CT160 repository. Created on CT190 (hostname aico), owner kasadis, secrets directory 0700, files 0600:
- /home/kasadis/.local/state/aico/secrets/backup-append.ed25519
- /home/kasadis/.local/state/aico/secrets/backup-append.password

No secret bytes were printed. CT160 repository initialization and the forced-command append-only path succeeded. CT190's restic client read its empty independent repository successfully (`snapshots` returned an empty list). Existing keys/repositories were not changed. Nightshift declarations cover davion-gem config/packages. Hosts > Logins only shows tool login metadata; it cannot reveal these backup secrets. The coordinator owns the approved password-manager handoff and received only host and paths.

Required review: review-codex.md. All eleven findings addressed with regression coverage. The first reproductions failed before the fixes; latest focused ops run: 64/64 passed (.dev-tools/vitest-18e4fdeadb669059-1645641-ddf367fe-details.txt). Tests cover physical-point aliases, independent receipt races, frozen-tree classification, omitted nested projects, baseline creation, source qualification, stale folder import, native-root verified restore, stream restore paths, auth-copy replacement and package/boot timing. Scheduling tests cover CT190 Run now and weekly verification entry.

Pending: final scoped quick gate and post-change acceptance; commits/deploy; clean Aico runs of native, Drive and append backends; one scratch restore and comparison; screenshots at 1600x900 and 390x844 plus rendered uilint; timer cutover and rollback evidence. Legacy backup timers remain enabled until clean replacement runs are verified. No backup data or snapshots have been manually pruned/forgotten/deleted.
