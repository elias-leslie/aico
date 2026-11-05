Publication rollback

Set ST_AICO_PUBLISH=0 for the calling CLI and the SF worker to route st vcs publish, publication policy and the retained nightly entry point back to SF. Remove only github-publish from packages/jobs/data/jobs.json, checkpoint that path and rebuild Aico so it stops owning the schedule. Copy any owner mode/hold changes made since cutover from Aico's registry back through SF's publication controls, then set SummitFlow's existing nightly_publication_enabled switch true. No token moves, direct GitHub push, force push, or source rollback is needed.

The retained transport leaf is st vcs deliver. It does not query SF's project registry or database. It verifies the Aico receipt and current main again, keeps the existing fast-forward push, complete outgoing-history secret verifier, and workflow-effects guard. The GitHub route is selected independently of a LAN branch upstream.
