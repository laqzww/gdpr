#!/bin/bash
set -e

RENDER_URL="${PUBLIC_URL:-https://blivhort-ai.onrender.com}"

echo "Testing Render deployment..."
echo "URL: $RENDER_URL"
echo ""

echo "1. Checking health endpoint..."
curl -s "$RENDER_URL/healthz" | jq . || echo "Failed"
echo ""

echo "2. Checking database status..."
curl -s "$RENDER_URL/api/db-status" | jq . || echo "Failed"
echo ""

echo "3. Triggering index rebuild..."
curl -s -X POST "$RENDER_URL/api/rebuild-index" | jq . || echo "Failed"
echo ""

echo "4. Waiting 10 seconds for index to build..."
sleep 10

echo "5. Testing search endpoint..."
curl -s "$RENDER_URL/api/search?q=test" | jq . || echo "Failed"
echo ""

echo "6. Checking database status again..."
curl -s "$RENDER_URL/api/db-status" | jq . || echo "Failed"
echo ""

echo "7. Manually triggering daily scrape..."
curl -s -X POST "$RENDER_URL/api/run-daily-scrape" | jq . || echo "Failed"
echo ""

echo "Test complete. Check the results above."