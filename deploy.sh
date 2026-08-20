#!/usr/bin/env bash
#
# Push the current `main` to the server and restart it.
#
#   ./deploy.sh
#
# Pulls on the server rather than copying from here, so what runs in production is exactly what is
# on GitHub — a deploy from a dirty working tree is how a machine ends up running code that exists
# nowhere else.
set -euo pipefail

HOST=${PROVA_HOST:-ubuntu@15.206.34.34}
# ~/.ssh, not ~/Downloads: a key sitting in the downloads folder gets tidied away or deleted, and an
# EC2 private key cannot be re-downloaded — AWS shows it once, at creation, and keeps no copy.
KEY=${PROVA_KEY:-$HOME/.ssh/prova-backend.pem}
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# One machine serves two hostnames, and BOTH are checked below. Checking only the API meant a broken
# website still printed a green tick: that is how a 502 on the marketing site and console survived a
# deploy unnoticed, found later by hand.
API_URL=${PROVA_API_URL:-https://provapayment.duckdns.org}
WEB_URL=${PROVA_WEB_URL:-https://provapay.duckdns.org}

# Refuse to deploy work that is not pushed: the server pulls from GitHub, so anything uncommitted or
# unpushed would silently not be deployed, and the version you tested locally is not the one running.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ uncommitted changes — commit them first, or they will not be deployed"
  git status --short
  exit 1
fi
if [[ -n "$(git log --oneline "origin/$(git branch --show-current)..HEAD" 2>/dev/null)" ]]; then
  echo "✗ commits not pushed — run: git push"
  exit 1
fi

echo "→ deploying $(git rev-parse --short HEAD) to $HOST"

# `up -d --build` rather than `restart`: it rebuilds changed images AND recreates containers whose
# configuration changed. `restart` would reuse the old image and the old environment.
ssh -i "$KEY" "$HOST" "
  set -e
  cd prova && git pull --ff-only
  cd backend && $COMPOSE up -d --build
"

# Wait for a URL to answer. Returns non-zero if it never does, so a caller can report which one
# failed rather than a single "deploy failed" that says nothing about where to look.
# -L follows redirects before judging. Without it a 3xx counts as success, because -f only fails on
# 4xx/5xx — so a site answering nothing but redirects would report healthy.
wait_for() {
  local url=$1
  for _ in $(seq 1 30); do
    curl -fsSL -m 5 -o /dev/null "$url" && return 0
    sleep 5
  done
  return 1
}

failed=()

echo "→ waiting for the API"
if wait_for "$API_URL/healthz"; then
  echo "  ✓ API   $(curl -s -m 5 "$API_URL/healthz")"
else
  echo "  ✗ API   $API_URL/healthz did not answer"
  failed+=("docker logs prova-backend-api-1 --tail 30")
fi

# The website is checked even when the API failed, so one run tells you everything that is wrong
# instead of surfacing the second problem only after you have fixed the first.
echo "→ waiting for the website"
if wait_for "$WEB_URL/"; then
  echo "  ✓ WEB   $WEB_URL"
else
  echo "  ✗ WEB   $WEB_URL did not answer"
  # A 502 here is usually the web container listening on the wrong port, or Caddy without a
  # certificate for this hostname yet.
  failed+=("docker logs prova-backend-web-1 --tail 30")
  failed+=("docker logs prova-backend-caddy-1 --tail 20")
fi

if (( ${#failed[@]} )); then
  echo "✗ deploy incomplete — check:"
  for cmd in "${failed[@]}"; do echo "  ssh -i $KEY $HOST '$cmd'"; done
  exit 1
fi

echo "✓ both live"
