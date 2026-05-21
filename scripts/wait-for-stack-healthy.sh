#!/usr/bin/env bash
set -euo pipefail

TIMEOUT=${WAIT_TIMEOUT:-120}
INTERVAL=2
ELAPSED=0

EXPECTED_SERVICES="wevibe-postgres wevibe-qdrant wevibe-chain wevibe-umbral wevibe-hub wevibe-dashboard wevibe-mcp"

echo "Waiting for stack to be healthy (timeout: ${TIMEOUT}s)..."

while [ $ELAPSED -lt $TIMEOUT ]; do
    ALL_HEALTHY=true
    for service in $EXPECTED_SERVICES; do
        STATUS=$(docker compose ps --format json "$service" 2>/dev/null | jq -r '.Health // "no-healthcheck"' 2>/dev/null || echo "missing")
        if [ "$STATUS" != "healthy" ] && [ "$STATUS" != "no-healthcheck" ]; then
            ALL_HEALTHY=false
            break
        fi
    done

    if $ALL_HEALTHY; then
        echo "All services healthy after ${ELAPSED}s."
        exit 0
    fi

    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
    if [ $((ELAPSED % 10)) -eq 0 ]; then
        echo "  Still waiting... (${ELAPSED}s elapsed)"
        docker compose ps
    fi
done

echo "ERROR: Stack did not become healthy within ${TIMEOUT}s."
docker compose ps
docker compose logs --tail=20
exit 1
