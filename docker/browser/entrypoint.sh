#!/bin/sh
# Starts Xvfb, a localhost-only VNC server, token-guarded noVNC, then the fixed browser driver.
set -eu

: "${NOVNC_TOKEN:?NOVNC_TOKEN is required}"
umask 077
mkdir -p /tmp/ctf
printf '%s: 127.0.0.1:5900\n' "$NOVNC_TOKEN" > /tmp/ctf/tokens
unset NOVNC_TOKEN

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
i=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && { echo "Xvfb did not start" >&2; exit 1; }
  sleep 0.1
done

# VNC listens only inside the container; noVNC/websockify is the sole published endpoint and
# rejects websocket connections without the per-run token.
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -quiet -noxdamage &
websockify --web /usr/share/novnc --token-plugin TokenFile --token-source /tmp/ctf/tokens 0.0.0.0:6080 >/tmp/ctf/websockify.log 2>&1 &

exec node /opt/ctf-driver/driver.mjs serve
