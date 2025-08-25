#!/usr/bin/env bash
set -euo pipefail
REMOTE_ALIAS=${RENDER_SSH_ALIAS:-render-srv}
SSH_OPTS=${SSH_OPTS:-"-o BatchMode=yes -o StrictHostKeyChecking=accept-new"}
CMD=${1:-}
shift || true
if [ -z "${CMD}" ]; then
  exec ssh ${SSH_OPTS} "${REMOTE_ALIAS}"
else
  exec ssh ${SSH_OPTS} "${REMOTE_ALIAS}" "${CMD}" "$@"
fi
