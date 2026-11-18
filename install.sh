#!/usr/bin/env bash
# FreeTheWebcam installer for a Linux server with Docker.
# Usage: ./install.sh          (asks for domain and email)
#      DOMAIN=cams.example.com ACME_EMAIL=me@example.com ./install.sh
#      FTW_DRY_RUN=1 ./install.sh   (only generates the configuration, no Docker or firewall)
# After that, everything is managed with ./ftw (updates, backups, OBS, recordings…).
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
rand() { openssl rand -hex "$1"; }

command -v openssl >/dev/null || die "openssl is missing"
if [[ "${FTW_DRY_RUN:-0}" != "1" ]]; then
  command -v docker >/dev/null || die "Docker is missing. Install it: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "the “docker compose” plugin is missing"
fi

if [[ -f .env ]]; then
  say "A .env already exists: reusing its configuration (delete .env to start over)."
else
  DOMAIN="${DOMAIN:-}"
  ACME_EMAIL="${ACME_EMAIL:-}"
  [[ -n "$DOMAIN" ]] || read -rp "Domain (must already point to this server), e.g. cams.example.com: " DOMAIN
  [[ -n "$ACME_EMAIL" ]] || read -rp "Email for the HTTPS certificate (Let's Encrypt): " ACME_EMAIL
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "invalid domain: $DOMAIN"
  [[ "$ACME_EMAIL" == *@* ]] || die "invalid email: $ACME_EMAIL"

  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
PUBLIC_URL=https://$DOMAIN
LIVEKIT_URL=wss://$DOMAIN
LIVEKIT_API_KEY=API$(rand 6)
LIVEKIT_API_SECRET=$(rand 32)
APP_SECRET=$(rand 32)
SETUP_TOKEN=$(rand 12)
POSTGRES_PASSWORD=$(rand 24)
REDIS_PASSWORD=$(rand 24)
NODE_ENV=production
# Visitor country (Cloudflare sends cf-ipcountry). Without the header the strictest rule applies.
GEO_HEADER=cf-ipcountry
DEFAULT_COUNTRY=
# Optional services: enable them with ./ftw enable obs|recording|turn
FTW_OBS=0
FTW_RECORDING=0
FTW_TURN=0
INGRESS_ENABLED=0
EGRESS_ENABLED=0
EOF
  say "Configuration saved to .env. It contains secrets: do not share it and keep a separate copy."
fi

if [[ "${FTW_DRY_RUN:-0}" == "1" ]]; then
  ./ftw config
  say "Test mode: configuration generated, nothing started."
  exit 0
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Opening ports in the firewall (ufw)…"
  ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
  ufw allow 7881/tcp && ufw allow 50000:60000/udp
else
  say "ufw is not active. Open in your firewall: 80/tcp, 443/tcp, 7881/tcp and 50000-60000/udp. All other services only listen on 127.0.0.1."
fi

say "Building and starting (the first time takes a few minutes)…"
./ftw up

# shellcheck disable=SC1091
set -a; source .env; set +a
say "Waiting for it to respond…"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
    say "Ready! Finish the installation at:"
    echo "  https://$DOMAIN/setup?token=$SETUP_TOKEN"
    echo
    echo "This link only works once. After that, everything is managed from https://$DOMAIN/admin"
    echo "Automatic backups: ./ftw cron"
    exit 0
  fi
  sleep 2
done
die "the application is not responding. Check: ./ftw logs app"
