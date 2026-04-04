#!/usr/bin/env bash
# Fix NetworkManager tearing down eno1 on carrier loss (router reboot)
#
# Problem: When the router restarts, the switch ports lose power causing
# carrier loss on wired connections. NetworkManager tears down the entire
# IP config and rebuilds from scratch on each bounce. Windows keeps its
# IP stack active through brief carrier loss — this makes Linux do the same.
#
# This only affects eno1 (static LAN IP via $LAN_IP). Since the IP is manually
# configured, there's no reason to re-negotiate on brief link drops.

set -euo pipefail

CONF="/etc/NetworkManager/conf.d/ignore-carrier-eno1.conf"

echo "Creating $CONF ..."
sudo tee "$CONF" > /dev/null <<'EOF'
[device-eno1]
match-device=interface-name:eno1
ignore-carrier=true
EOF

echo "Reloading NetworkManager configuration..."
sudo nmcli general reload

echo "Verifying..."
if [ -f "$CONF" ]; then
    echo "OK — eno1 will now keep its IP config during carrier loss"
    cat "$CONF"
else
    echo "FAILED — config file not created"
    exit 1
fi
