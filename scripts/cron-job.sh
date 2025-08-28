#!/bin/bash
# Robust cron job launcher for Render

echo "[CRON-JOB] Starting cron job launcher..."
echo "[CRON-JOB] Current directory: $(pwd)"
echo "[CRON-JOB] NODE_PATH: $NODE_PATH"

# First, let's find where everything is
echo "[CRON-JOB] Searching for node_modules and package.json..."
find /opt/render -name "node_modules" -type d 2>/dev/null | head -10
echo "[CRON-JOB] Searching for package.json..."
find /opt/render -name "package.json" -type f 2>/dev/null | head -10

# Check if we need to install dependencies
if [ ! -d "node_modules" ] && [ -f "package.json" ]; then
    echo "[CRON-JOB] node_modules not found, installing dependencies..."
    npm install --production --no-audit --no-fund
fi

# Now try to run the cron job
if [ -d "node_modules" ]; then
    echo "[CRON-JOB] Running from current directory with local node_modules"
    node scripts/combined-cron.js
elif [ -d "/opt/render/project/node_modules" ]; then
    echo "[CRON-JOB] Found node_modules at /opt/render/project/node_modules"
    cd /opt/render/project
    node src/scripts/combined-cron.js
elif [ -d "../node_modules" ]; then
    echo "[CRON-JOB] Found node_modules in parent directory"
    cd ..
    node src/scripts/combined-cron.js
else
    echo "[CRON-JOB] ERROR: Could not find node_modules anywhere!"
    echo "[CRON-JOB] Current directory contents:"
    ls -la
    echo "[CRON-JOB] Parent directory contents:"
    ls -la ..
    exit 1
fi