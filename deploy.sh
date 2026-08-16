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
KEY=${PROVA_KEY:-$HOME/Downloads/prova-backend.pem}
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

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

echo "→ waiting for the API to answer"
for _ in $(seq 1 30); do
  if curl -fsS -m 5 https://provapayment.duckdns.org/healthz >/dev/null 2>&1; then
    echo "✓ live: $(curl -s -m 5 https://provapayment.duckdns.org/healthz)"
    exit 0
  fi
  sleep 5
done

echo "✗ the API did not come back — check the logs:"
echo "  ssh -i $KEY $HOST 'docker logs prova-backend-api-1 --tail 30'"
exit 1
