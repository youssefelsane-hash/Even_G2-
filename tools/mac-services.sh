#!/bin/bash
# Runs the backend and the glasses dev server as macOS login services (launchd):
# they start when you log in, restart within seconds if they crash, and keep the
# Mac from idle-sleeping while they run (caffeinate). Closing the lid on battery
# still sleeps the Mac; on the charger with the lid open it stays up.
#
#   tools/mac-services.sh install     write the services and start them
#   tools/mac-services.sh status      show whether they run, and the last log lines
#   tools/mac-services.sh restart     restart both (after changing backend/.env)
#   tools/mac-services.sh uninstall   stop them and remove the services
#
# Logs: ~/Library/Logs/even-g2/backend.log and devserver.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/even-g2"
DOMAIN="gui/$(id -u)"
NAMES=(com.even-g2.backend com.even-g2.devserver)

plist() { # label workdir args...
  local label="$1" dir="$2"; shift 2
  local args=""
  for a in "$@"; do args+="    <string>${a}</string>"$'\n'; done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${LOGS}/${label#com.even-g2.}.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/${label#com.even-g2.}.log</string>
</dict>
</plist>
EOF
}

stop_all() {
  for n in "${NAMES[@]}"; do launchctl bootout "$DOMAIN/$n" 2>/dev/null || true; done
}

case "${1:-status}" in
  install)
    [ -f "$ROOT/backend/.env" ] || { echo "backend/.env is missing: set up the backend first"; exit 1; }
    mkdir -p "$AGENTS" "$LOGS"
    stop_all
    # caffeinate -ims keeps the Mac out of idle and system sleep while the server runs.
    plist com.even-g2.backend "$ROOT/backend" /usr/bin/caffeinate -ims "$NODE" --env-file-if-exists=.env src/main.ts \
      > "$AGENTS/com.even-g2.backend.plist"
    plist com.even-g2.devserver "$ROOT/app" "$NODE" "$ROOT/app/node_modules/vite/bin/vite.js" --host 0.0.0.0 --port 5174 --strictPort \
      > "$AGENTS/com.even-g2.devserver.plist"
    for n in "${NAMES[@]}"; do launchctl bootstrap "$DOMAIN" "$AGENTS/$n.plist"; done
    echo "Installed. Logs in $LOGS"
    ;;
  restart)
    for n in "${NAMES[@]}"; do launchctl kickstart -k "$DOMAIN/$n"; done
    echo "Restarted."
    ;;
  uninstall)
    stop_all
    for n in "${NAMES[@]}"; do rm -f "$AGENTS/$n.plist"; done
    echo "Removed."
    ;;
  status)
    for n in "${NAMES[@]}"; do
      if launchctl print "$DOMAIN/$n" >/dev/null 2>&1; then
        state=$(launchctl print "$DOMAIN/$n" | awk -F'= ' '/^\tstate/{print $2; exit}')
        echo "$n: ${state:-loaded}"
      else
        echo "$n: not installed"
      fi
    done
    curl -s -m 3 http://127.0.0.1:8787/v1/healthz >/dev/null && echo "backend: answering" || echo "backend: not answering"
    curl -s -m 3 -o /dev/null http://127.0.0.1:5174/ && echo "dev server: answering" || echo "dev server: not answering"
    for f in backend devserver; do echo "--- $f.log"; tail -n 3 "$LOGS/$f.log" 2>/dev/null || true; done
    ;;
  *)
    echo "usage: $0 install|status|restart|uninstall"; exit 2 ;;
esac
