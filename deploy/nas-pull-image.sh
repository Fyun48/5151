#!/bin/sh
set -eu
cd /mnt/Storage1/apps/5151
docker pull ghcr.io/fyun48/5151:latest
docker compose up -d --no-build --no-deps 591-tracker
docker stop 591-tracker-watchtower >/dev/null 2>&1 || true
docker rm 591-tracker-watchtower >/dev/null 2>&1 || true
