#!/bin/bash
# The Tailscale CLI for the userspace tailscaled that tools/mac-services.sh runs.
#   tools/ts.sh status | up | funnel --bg 8787 | funnel status | ...
exec tailscale --socket="$HOME/Library/Application Support/even-g2/tailscale/tailscaled.sock" "$@"
