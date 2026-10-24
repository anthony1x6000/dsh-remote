#!/bin/bash
# Portable-bridge end-to-end test: dsh web + dsh-remote + two PortableTailscale
# roles against a loopback fake control server, no secrets anywhere.
#
# Topology (all on one runner):
#
#   harness (fake control + DERP + peer) --- portable node "dsh-e2e" (spawned
#   by dsh-remote) --- [tailnet] --- client portable node (PAC proxy on
#   127.0.0.1:41112) --- curl
#
#   dsh web binds 127.0.0.1:3080; dsh-remote's portable mode bridges the
#   dsh-e2e node's tailnet port 3080 onto it. Success is curl, through the
#   client node's proxy, loading the authenticated GUI URL printed by
#   dsh-remote.
#
# Environment: PT_DIR (PortableTailscale checkout), DSH (dsh CLI path).

set -eu

PT_DIR=${PT_DIR:?PT_DIR must point at a PortableTailscale checkout}
DSH=${DSH:?DSH must point at the dsh CLI}
WORK=/tmp/portable-e2e
PIDS=""

cleanup() {
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

dump_logs() {
  for f in "$WORK"/dsh.out "$WORK"/dsh.err "$WORK"/harness.out "$WORK"/harness.err "$WORK"/client.out "$WORK"/client.err; do
    if [ -f "$f" ]; then echo "===== $f (tail) ====="; tail -n 25 "$f"; fi
  done
}
trap dump_logs ERR

fail() { echo "portable-e2e: $*" >&2; exit 1; }

mkdir -p "$WORK"

echo "== build PortableTailscale and the fake-control harness"
( cd "$PT_DIR" && ./scripts/patch-tsnet-peerapi.sh \
  && go build -o "$WORK/PortableTailscale" ./cmd/portabletailscale \
  && go build -o "$WORK/harness" ./test/harness ) || fail "build failed"

echo "== start the fake tailnet world"
"$WORK/harness" > "$WORK/harness.out" 2> "$WORK/harness.err" & PIDS="$PIDS $!"
CONTROL=""
for _ in $(seq 1 60); do
  CONTROL=$(sed -n 's/^control=//p' "$WORK/harness.out" | head -n 1)
  [ -n "$CONTROL" ] && break
  sleep 1
done
[ -n "$CONTROL" ] || fail "harness never became ready"
echo "   control: $CONTROL"

echo "== boot dsh web with the portable bridge"
# The plugin spawns the server-side PortableTailscale itself; the fake key and
# control URL make its login headless.
export DSH_REMOTE_PORTABLE_BIN="$WORK/PortableTailscale"
export DSH_REMOTE_PORTABLE_HOSTNAME=dsh-e2e
export DSH_REMOTE_PORTABLE_ARGS="--control-url $CONTROL"
export TS_AUTHKEY=e2e-key
"$DSH" --profile portable-e2e web > "$WORK/dsh.out" 2> "$WORK/dsh.err" & PIDS="$PIDS $!"

GUI_URL=""
for _ in $(seq 1 120); do
  GUI_URL=$(sed -n 's/^dsh-remote (portable): //p' "$WORK/dsh.out" | head -n 1)
  [ -n "$GUI_URL" ] && break
  sleep 1
done
[ -n "$GUI_URL" ] || fail "dsh-remote never printed the portable URL"
echo "   gui url: $GUI_URL"

echo "== start the client-side node with the PAC proxy"
"$WORK/PortableTailscale" --install --no-browser --json --control-url "$CONTROL" \
  > "$WORK/client.out" 2> "$WORK/client.err" & PIDS="$PIDS $!"
for _ in $(seq 1 120); do
  grep -q '"event":"connected"' "$WORK/client.out" && break
  sleep 1
done
grep -q '"event":"connected"' "$WORK/client.out" || fail "client node never connected"
echo "   client connected"

echo "== fetch the GUI through the client proxy"
PROXY=http://127.0.0.1:41112
CODE=$(curl -sS -L --max-time 30 -x "$PROXY" -o "$WORK/page.html" -w '%{http_code}' "$GUI_URL") \
  || fail "curl through the proxy failed"
[ "$CODE" = "200" ] || fail "expected HTTP 200 through the bridge, got $CODE"
grep -qi '<html' "$WORK/page.html" || fail "the response is not the GUI page"

echo "== the /api fence accepts the tailnet authority"
# The session cookie from the tokenized URL must let /api answer something
# other than the 403 the Host fence gives untrusted authorities.
curl -sS -c "$WORK/jar" -b "$WORK/jar" --max-time 30 -x "$PROXY" -o /dev/null "$GUI_URL"
API_CODE=$(curl -sS -b "$WORK/jar" --max-time 30 -x "$PROXY" -o /dev/null -w '%{http_code}' "${GUI_URL%%\?*}/api") \
  || fail "curl against /api failed"
[ "$API_CODE" != "403" ] || fail "/api answered 403: the tailnet name was not trusted"
echo "   /api answered $API_CODE (fence passed)"

echo "portable-e2e: PASS"
