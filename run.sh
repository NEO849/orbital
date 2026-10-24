#!/usr/bin/env bash
# orbital — 1-Befehl-Start / one-command launch.
#
#   ./run.sh              -> synthetische DEMO  (Default: sicher, liest NICHTS Echtes)
#   ./run.sh live         -> Live-Modus (liest ~/.claude READ-ONLY; nur mit aos.local.json sinnvoll)
#   AOS_PORT=9000 ./run.sh [demo|live]   -> anderer Port (Default 8080)
#
# Bind kommt aus config.py (Public-Default 127.0.0.1 — NIE 0.0.0.0; eigene IP via
# collector/aos.local.json). Producer schreibt state.json/events.jsonl, serve.py liest sie (GET-only).
set -euo pipefail
cd "$(dirname "$0")/collector"

MODE="${1:-demo}"
PORT="${AOS_PORT:-8080}"
case "$MODE" in
  demo) PRODUCER=demo.py ;;
  live) PRODUCER=collector.py ;;
  -h|--help|help) echo "Usage: $0 [demo|live]   (env: AOS_PORT=<port>)"; exit 0 ;;
  *) echo "Unbekannter Modus: '$MODE' (erlaubt: demo | live)"; exit 2 ;;
esac

command -v python3 >/dev/null 2>&1 || { echo "python3 nicht gefunden"; exit 1; }

echo "orbital  mode=$MODE  producer=$PRODUCER  port=$PORT"
echo "  -> http://127.0.0.1:$PORT   (bzw. dein in aos.local.json gesetztes Bind)"
echo "  (Strg-C beendet Producer + Server)"

# Producer im Hintergrund; Server im Vordergrund. trap raeumt den Producer beim Beenden auf.
python3 "$PRODUCER" --daemon &
PROD_PID=$!
cleanup() { kill "$PROD_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# kurz warten, bis der erste state.json-Tick geschrieben ist (sauberer erster GET)
for _ in $(seq 1 20); do [ -f state.json ] && break; sleep 0.25; done

python3 serve.py "$PORT"
