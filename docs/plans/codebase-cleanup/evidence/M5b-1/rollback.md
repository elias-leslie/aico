The old Nightshift files and units are retained. No keys, phone pairing data, baselines, or history were deleted.

Workstation rollback (coordinate with the grants lane before restoring its runner):

```sh
sudo systemctl --no-ask-password disable --now host-steward-heartbeat.timer host-steward-fcm-token.timer host-steward-rules.timer
sudo systemctl --no-ask-password enable --now nightshift-check.timer nightshift-fcm-token.timer nightshift-runner-critical.timer nightshift-runner-nightly.timer nightshift-runner-weekly.timer nightshift-runner-monthly.timer nightshift-runner-critical.path
systemctl --user --no-ask-password enable --now nightshift-notify-critical.timer nightshift-notify-critical.path
```

Gem rollback:

```sh
systemctl --no-ask-password disable --now aico-pve-sender.timer
systemctl --no-ask-password stop aico-pve-sender.service
cp -p /usr/local/sbin/aico-push.pre-aico /usr/local/sbin/aico-push
systemctl --no-ask-password enable --now nightshift-nightwatch.timer nightshift-nightwatch-web.service
pct exec 190 -- systemctl --no-ask-password disable --now host-steward-heartbeat.timer
```

This restores the old workstation-to-gem heartbeat and sender. The earlier M5a acting-controller cutover is separate and stays in place. If reverting all of M5b with the grants lane, it also restores the old floor-path configuration from before the sender source checkpoint. Restore the floor block with a scoped patch; do not reset the shared checkout.
