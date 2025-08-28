#!/bin/bash
# HTTP-based cron job for Render

echo "[CRON-HTTP] Starting HTTP-based cron job..."
echo "[CRON-HTTP] Current time: $(date)"

PUBLIC_URL="${PUBLIC_URL:-https://blivhort-ai.onrender.com}"

echo "[CRON-HTTP] Using PUBLIC_URL: $PUBLIC_URL"

# Call the daily scrape endpoint
echo "[CRON-HTTP] Triggering daily scrape..."
curl -X POST "$PUBLIC_URL/api/run-daily-scrape" \
  -H "Content-Type: application/json" \
  -d '{"reason": "scheduled_daily_cron"}' \
  -m 300 \
  --fail \
  --show-error \
  || { echo "[CRON-HTTP] Daily scrape failed"; exit 1; }

echo "[CRON-HTTP] Daily scrape triggered successfully"

# Wait a bit before checking status
sleep 30

# Check database status
echo "[CRON-HTTP] Checking database status..."
curl "$PUBLIC_URL/api/db-status" \
  -m 30 \
  --fail \
  --show-error \
  || echo "[CRON-HTTP] Failed to get database status"

echo "[CRON-HTTP] Cron job completed successfully"