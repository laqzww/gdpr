#!/usr/bin/env bash
set -euo pipefail

# Simple server manager for server.js
# Commands: start | stop | restart | status | logs | run

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/tmp/server.pid"
LOG_FILE="$ROOT_DIR/tmp/server.out"
PORT="${PORT:-3010}"

ensure_tmp_dir() {
  mkdir -p "$ROOT_DIR/tmp"
}

pid_from_file() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  fi
}

pid_listening_on_port() {
  lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

stop_port_listeners() {
  local pids
  pids="$(pid_listening_on_port)"
  if [[ -n "${pids}" ]]; then
    kill -TERM ${pids} 2>/dev/null || true
    sleep 1
    pids="$(pid_listening_on_port)"
    if [[ -n "${pids}" ]]; then
      kill -KILL ${pids} 2>/dev/null || true
    fi
  fi
}

stop_pid_file() {
  local pid
  pid="$(pid_from_file || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 5); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE" 2>/dev/null || true
}

cmd_start() {
  ensure_tmp_dir
  # Ensure the port is free before starting
  stop_pid_file
  stop_port_listeners
  nohup node "$ROOT_DIR/server.js" >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 0.5
  echo "Started server (PID $(cat "$PID_FILE")) on http://localhost:$PORT"
  tail -n 3 "$LOG_FILE" || true
}

cmd_stop() {
  stop_pid_file
  stop_port_listeners
  echo "Stopped server on port $PORT (if it was running)."
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  local pids
  pids="$(pid_listening_on_port)"
  if [[ -n "$pids" ]]; then
    echo "Server listening on port $PORT (PID(s): $pids)"
  else
    echo "Server not running on port $PORT"
  fi
  if [[ -f "$PID_FILE" ]]; then
    echo "PID file: $(cat "$PID_FILE") -> $PID_FILE"
  fi
}

cmd_logs() {
  ensure_tmp_dir
  : "${LINES:=200}"
  tail -n "$LINES" -f "$LOG_FILE"
}

cmd_run() {
  # Foreground run (Ctrl+C to stop). Ensure port is free first.
  stop_pid_file
  stop_port_listeners
  PORT="$PORT" node "$ROOT_DIR/server.js"
}

usage() {
  cat <<USAGE
Usage: $(basename "$0") <command>
Commands:
  start      Start server in background (writes $PID_FILE, logs to $LOG_FILE)
  stop       Stop server and free port $PORT
  restart    Restart server
  status     Show server status
  logs       Tail logs (env LINES=N to set initial lines)
  run        Run in foreground (Ctrl+C to stop)
USAGE
}

cmd="${1:-}" || true
case "$cmd" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  status) shift; cmd_status "$@" ;;
  logs) shift; cmd_logs "$@" ;;
  run) shift; cmd_run "$@" ;;
  *) usage; exit 1 ;;
esac


