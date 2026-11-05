# Tooling observations

The launch shell lacked XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS. Supplying the existing user runtime directory and bus let managed rebuild queue normally. A deploy-result query without that environment incorrectly called the still-running job gone; systemd proved its process live, and the runner subsequently wrote success. No build was killed or duplicated. Final deploy-result receipts supersede the early wait result.

`st aico wait job` rejected the domain deploy ID printed by `st service rebuild`; the domain `aico deploy wait` with user-bus environment handled the later jobs. A managed command wait also reported a malformed SERVICE_RESULT token after its watcher finished; this did not affect deployment. These are tooling findings for the coordinator, not changes in this cleanup.
