#!/bin/bash
set -e

RENDER_URL="${PUBLIC_URL:-https://blivhort-ai.onrender.com}"

echo "Testing Render deployment..."
echo "URL: $RENDER_URL"
echo ""

echo "1. Checking health endpoint..."
curl -s "$RENDER_URL/healthz" || echo "Failed"
echo ""

echo "2. Checking database status..."
curl -s "$RENDER_URL/api/db-status" || echo "Failed"
echo ""

echo "3. Testing SQLite installation..."
curl -s "$RENDER_URL/api/test-sqlite" || echo "Failed" 
echo ""

echo "4. Forcing database re-initialization (POST)..."
curl -s -X POST "$RENDER_URL/api/db-reinit" || echo "Failed"
echo ""

echo "5. Checking database status after reinit..."
curl -s "$RENDER_URL/api/db-status" || echo "Failed"
echo ""

echo "6. Triggering index rebuild..."
curl -s -X POST "$RENDER_URL/api/rebuild-index" || echo "Failed"
echo ""

echo "7. Waiting 10 seconds for index to build..."
sleep 10

echo "8. Testing search endpoint..."
curl -s "$RENDER_URL/api/search?q=test" || echo "Failed"
echo ""

echo "9. Checking database status again..."
curl -s "$RENDER_URL/api/db-status" || echo "Failed"
echo ""

echo "10. Manually triggering daily scrape..."
curl -s -X POST "$RENDER_URL/api/run-daily-scrape" || echo "Failed"
echo ""

echo "11. Waiting 30 seconds for scrape to process..."
sleep 30

echo "12. Final database status check..."
curl -s "$RENDER_URL/api/db-status" || echo "Failed"
echo ""

echo "Test complete. Check the results above."