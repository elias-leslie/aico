# Codex review

Required independent Codex review completed over the root grants, rules, installer, drill and UI integration.

Concrete findings and fixes:
- Tray expected code 200 after FIDO approval. Added a failing protocol regression, returned the expected code.
- Slow checks were falsely stale after 30 minutes. Saved each check schedule plus slack and used that deadline.
- Owner warnings were never cleared. Recorded owner episodes and published the same row as healthy when cleared; added a failing regression.
- Signed updates left the old grants process running. Added a failing installer regression and restart after verified installation.
- Tray browser links still opened the retired approval page. Added a failing Rust test and linked to Grants.

Evidence: review-tray-red.txt, review-rules-red.txt, review-update-red.txt, review-link-red.txt, review-fixes-green.txt. Live tap delivery is checked separately; socket open alone is not tray evidence.
