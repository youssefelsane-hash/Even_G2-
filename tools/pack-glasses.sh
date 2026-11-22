#!/bin/bash
# Builds the glasses app for a permanent (Beta) install in the Even app, pointed
# at an https answer server, and prints the phone pairing link.
#
#   tools/pack-glasses.sh https://your-mac.your-tailnet.ts.net
#
# What it does:
# 1. Gives the installed app its own token (kept in app/.pack.local, git-ignored)
#    and adds that token's digest to backend/.env, then restarts the backend.
# 2. Builds app/dist with the server address and token built in
#    (app/.env.production.local, git-ignored), so nothing is typed on the phone.
# 3. Writes a manifest whose network whitelist is that server (app/.pack/app.json)
#    and packs app/.pack/g2-assistant.ehpk.
# 4. Prints the phone photo page's pairing link as a QR code.
#
# The token ends up inside the .ehpk, which goes to Even Hub as a private Beta.
# To revoke it, remove its digest from CLIENT_TOKEN_SHA256 in backend/.env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIGIN="${1:-}"
[[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "usage: $0 https://host (an https origin, no path)"; exit 2; }
ENV_FILE="$ROOT/backend/.env"
[ -f "$ENV_FILE" ] || { echo "backend/.env is missing"; exit 1; }

cd "$ROOT/app"
PACK_TOKEN_FILE=".pack.local"
if [ ! -s "$PACK_TOKEN_FILE" ]; then
  (umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))' > "$PACK_TOKEN_FILE")
fi
TOKEN="$(cat "$PACK_TOKEN_FILE")"
DIGEST="$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
if ! grep -q "$DIGEST" "$ENV_FILE"; then
  node -e '
    const fs = require("fs"); const [file, digest] = process.argv.slice(1);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith("CLIENT_TOKEN_SHA256="));
    if (i < 0) lines.push(`CLIENT_TOKEN_SHA256=${digest}`);
    else { const v = lines[i].slice(20); lines[i] = `CLIENT_TOKEN_SHA256=${v ? `${v},` : ""}${digest}`; }
    fs.writeFileSync(file, lines.join("\n"));' "$ENV_FILE" "$DIGEST"
  echo "Added the installed app's token to backend/.env."
  "$ROOT/tools/mac-services.sh" restart >/dev/null 2>&1 || echo "Restart the backend yourself so it accepts the new token."
fi

(umask 077; printf 'VITE_SERVER_URL=%s\nVITE_SERVER_TOKEN=%s\n' "$ORIGIN" "$TOKEN" > .env.production.local)
npm run build >/dev/null
echo "Built app/dist for $ORIGIN."

mkdir -p .pack
node -e '
  const fs = require("fs"); const origin = process.argv[1];
  const m = JSON.parse(fs.readFileSync("app.json", "utf8"));
  for (const p of m.permissions) if (p.name === "network") p.whitelist = [origin];
  fs.writeFileSync(".pack/app.json", JSON.stringify(m, null, 2) + "\n");' "$ORIGIN"
npx evenhub pack .pack/app.json dist -o .pack/g2-assistant.ehpk
echo "Packed app/.pack/g2-assistant.ehpk (version $(node -p 'require("./app.json").version'))."

DEVICE="$(node -e 'const t = JSON.parse(require("fs").readFileSync(".dev-backend.local", "utf8")); process.stdout.write(`t=${encodeURIComponent(t.deviceToken)}&d=${encodeURIComponent(t.deviceId)}`)')"
echo
echo "Phone photo page: scan this once with the phone camera (it pairs the phone, then works anywhere):"
npx evenhub qr --url "$ORIGIN/phone#$DEVICE" 2>/dev/null | grep -v "Next" || echo "$ORIGIN/phone#$DEVICE"
echo
echo "Next, signed in with 'npx evenhub login' (you type the password):"
echo "  cd app"
echo "  npx evenhub create .pack/g2-assistant.ehpk --name \"G2 Assistant\" --tagline \"Personal assistant\"   # first time only"
echo "  npx evenhub upload .pack/g2-assistant.ehpk -m \"what changed\"                                     # later versions"
echo "  npx evenhub testers add <your email>"
echo "  npx evenhub promote <version> --to beta"
echo "Then in the Even app: Me, Beta tester, Install."
