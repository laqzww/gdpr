#!/bin/bash
# Wrapper script for combined-cron.js that ensures proper module resolution

# Set the NODE_PATH to the parent directory's node_modules
export NODE_PATH="/opt/render/project/node_modules:$NODE_PATH"

# Alternative: If node_modules is in /opt/render/project/src/node_modules
if [ -d "/opt/render/project/src/node_modules" ]; then
    export NODE_PATH="/opt/render/project/src/node_modules:$NODE_PATH"
fi

# Run the cron job
echo "[CRON-WRAPPER] Starting with NODE_PATH=$NODE_PATH"
node "$(dirname "$0")/combined-cron.js"