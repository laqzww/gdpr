#!/bin/bash
# Simple working fetch script
# This script uses the existing server infrastructure to populate the database

set -e

echo "[SIMPLE FETCH] Starting simple working fetch..."
cd /opt/render/project/src

# Step 1: Initialize database directly
echo "[SIMPLE FETCH] Step 1: Initializing database..."
node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = '/opt/render/project/src/fetcher/data/app.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

console.log('Creating database at:', dbPath);
const db = new Database(dbPath);

// Create all tables
db.exec(\`
    CREATE TABLE IF NOT EXISTS hearings(
      id INTEGER PRIMARY KEY,
      title TEXT,
      start_date TEXT,
      deadline TEXT,
      status TEXT,
      updated_at INTEGER,
      complete INTEGER,
      signature TEXT,
      total_responses INTEGER,
      archived INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS responses(
      hearing_id INTEGER,
      response_id TEXT PRIMARY KEY,
      org_name TEXT,
      submitted_date TEXT,
      pdf_url TEXT,
      created_at INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS materials(
      hearing_id INTEGER,
      material_id TEXT PRIMARY KEY,
      title TEXT,
      pdf_url TEXT,
      created_at INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_hearings_status ON hearings(status);
    CREATE INDEX IF NOT EXISTS idx_responses_hearing ON responses(hearing_id);
    CREATE INDEX IF NOT EXISTS idx_materials_hearing ON materials(hearing_id);
\`);

console.log('Database initialized successfully');
db.close();
"

# Step 2: Force database re-init on the running server
echo -e "\n[SIMPLE FETCH] Step 2: Forcing database re-initialization..."
curl -X POST https://blivhort-ai.onrender.com/api/db-reinit || true

# Step 3: Trigger index rebuild (this fetches hearings)
echo -e "\n[SIMPLE FETCH] Step 3: Rebuilding hearing index..."
curl -X POST https://blivhort-ai.onrender.com/api/rebuild-index \
  -H "Content-Type: application/json" \
  --max-time 300 || true

# Wait for processing
echo -e "\n[SIMPLE FETCH] Waiting for index rebuild..."
sleep 30

# Step 4: Check status
echo -e "\n[SIMPLE FETCH] Step 4: Checking database status..."
curl -s https://blivhort-ai.onrender.com/api/db-status | python3 -c "
import json, sys
data = json.load(sys.stdin)
print('Database status:')
print(f'  Hearings: {data.get(\"hearingCount\", 0)}')
print(f'  Responses: {data.get(\"responseCount\", 0)}')
print(f'  Materials: {data.get(\"materialCount\", 0)}')
"

# Step 5: Get hearing list and prefetch some data
echo -e "\n[SIMPLE FETCH] Step 5: Fetching hearing list..."
HEARINGS=$(curl -s https://blivhort-ai.onrender.com/api/hearing-index | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if data.get('success'):
        hearings = data.get('hearings', [])
        # Get active hearings
        active = [h for h in hearings if any(x in (h.get('status', '') or '').lower() for x in ['aktiv', 'afventer', 'høring'])]
        # Print first 10 IDs
        for h in active[:10]:
            print(h['id'])
except:
    pass
")

if [ -n "$HEARINGS" ]; then
    echo "[SIMPLE FETCH] Found active hearings to prefetch"
    echo "$HEARINGS" | head -5 | while read -r hearing_id; do
        if [ -n "$hearing_id" ]; then
            echo "[SIMPLE FETCH] Prefetching hearing $hearing_id..."
            curl -X POST "https://blivhort-ai.onrender.com/api/prefetch/$hearing_id?apiOnly=1" \
              -H "Content-Type: application/json" \
              -d '{"reason":"simple_fetch"}' \
              --max-time 60 || true
            sleep 2
        fi
    done
else
    echo "[SIMPLE FETCH] No active hearings found or server not responding"
fi

# Final check
echo -e "\n[SIMPLE FETCH] Final status check..."
curl -s https://blivhort-ai.onrender.com/api/db-status | python3 -c "
import json, sys
data = json.load(sys.stdin)
print('\nFinal database status:')
print(f'  Hearings: {data.get(\"hearingCount\", 0)}')
print(f'  Responses: {data.get(\"responseCount\", 0)}')
print(f'  Materials: {data.get(\"materialCount\", 0)}')
print(f'  DB Path: {data.get(\"dbPath\")}')
print(f'  DB Exists: {data.get(\"dbExists\")}')
"

echo -e "\n[SIMPLE FETCH] Done!"