#!/usr/bin/env bash
#
# Runs ON kb, piped over SSH by .github/workflows/deploy.yml.
# Pulls the pushed commit, reinstalls only when the lockfile changed, rebuilds
# the contract packages, and restarts the server. Local-only files (.env,
# cookies.txt, dist/) are untracked and therefore untouched by the reset.
set -euo pipefail

cd /home/ubuntu/doty

BEFORE=$(git rev-parse HEAD)
git fetch origin master
git reset --hard origin/master
AFTER=$(git rev-parse HEAD)
echo "deployed ${BEFORE:0:9} -> ${AFTER:0:9}"

if ! git diff --quiet "$BEFORE" "$AFTER" -- package-lock.json; then
  echo "package-lock.json changed: running npm ci"
  npm ci --no-audit --no-fund
fi

npm run build:contracts

if ! git diff --quiet "$BEFORE" "$AFTER" -- apps/server/src/integrations/command-classifier.ts apps/server/src/integrations/discord-routing.ts apps/server/src/integrations/discord-routing-smoke.ts; then
  node --import tsx apps/server/src/integrations/discord-routing-smoke.ts
fi

# The browser is provisioned from versioned code; there are no manual kb edits.
if ! git diff --quiet "$BEFORE" "$AFTER" -- apps/server/browser-worker apps/server/scripts/provision-browser.sh; then
  bash apps/server/scripts/provision-browser.sh
fi

sudo -n systemctl restart doty-server
sleep 5
echo "doty-server=$(systemctl is-active doty-server)"
curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:8787/health
