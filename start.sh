#!/usr/bin/env bash
# Kill ports -> build web static -> start `npm run dev:local`. Linux / macOS.
# Counterpart of start.bat.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

PORTS="2208 2200"
# Dev runners that sit above the listener; left alive they would respawn it or fight the new server.
RUNNER='nodemon|npm-cli|npm run|devServer|devWebLocal|run-p|next/dist'

pids_on_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n'
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2
  fi
}

parent_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
is_runner() { ps -o command= -p "$1" 2>/dev/null | grep -Eq "$RUNNER"; }

# Children first, so a parent cannot respawn what was just killed.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}

free_ports() {
  local port pid top parent roots=" "
  for port in $PORTS; do
    for pid in $(pids_on_port "$port"); do
      top=$pid
      while parent=$(parent_of "$top"); [ -n "$parent" ] && [ "$parent" -gt 1 ] && [ "$parent" != "$$" ] && is_runner "$parent"; do
        top=$parent
      done
      case "$roots" in *" $top "*) ;; *) roots="$roots$top " ;; esac
    done
  done

  local root
  for root in $roots; do
    echo "  stopping pid $root ($(ps -o comm= -p "$root" 2>/dev/null))"
    kill_tree "$root"
  done

  # Wait for the sockets to close; escalate once before giving up.
  local i busy
  for i in $(seq 1 20); do
    busy=""
    for port in $PORTS; do [ -n "$(pids_on_port "$port")" ] && busy="$busy $port"; done
    [ -z "$busy" ] && return 0
    if [ "$i" -eq 10 ]; then
      for port in $PORTS; do for pid in $(pids_on_port "$port"); do kill -9 "$pid" 2>/dev/null; done; done
    fi
    sleep 0.5
  done
  echo "  still in use:$busy"
  return 1
}

echo "[1/3] Freeing ports $PORTS..."
free_ports || { echo "Could not free the ports."; exit 1; }

echo "[2/3] Building web static bundle..."
node scripts/buildWebStatic.mjs || { echo "Build failed - server not started."; exit 1; }

echo "[3/3] Starting npm run dev:local..."
exec npm run dev:local
