#!/bin/bash
# Robust cron job launcher for Render

echo "[CRON-JOB] Starting cron job launcher..."
echo "[CRON-JOB] Current directory: $(pwd)"
echo "[CRON-JOB] Looking for node_modules..."

# Find where node_modules is located
if [ -d "/opt/render/project/node_modules" ]; then
    echo "[CRON-JOB] Found node_modules at /opt/render/project/node_modules"
    cd /opt/render/project
    node src/scripts/combined-cron.js
elif [ -d "/opt/render/project/src/node_modules" ]; then
    echo "[CRON-JOB] Found node_modules at /opt/render/project/src/node_modules"
    cd /opt/render/project/src
    node scripts/combined-cron.js
else
    echo "[CRON-JOB] ERROR: Could not find node_modules!"
    echo "[CRON-JOB] Checking common locations:"
    ls -la /opt/render/project/ 2>/dev/null || echo "  - /opt/render/project/ not found"
    ls -la /opt/render/project/src/ 2>/dev/null || echo "  - /opt/render/project/src/ not found"
    exit 1
fi