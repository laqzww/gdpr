#!/bin/bash
# Fix Render database issue

echo "[FIX] Starting database fix..."

# 1. Test if better-sqlite3 works
echo "[FIX] Testing better-sqlite3..."
node -e "console.log('better-sqlite3:', typeof require('better-sqlite3'))" 2>&1

# 2. Find working database
echo -e "\n[FIX] Finding databases..."
for db in /opt/render/project/src/fetcher/data/app.sqlite /opt/render/project/src/data/app.sqlite; do
    if [ -f "$db" ]; then
        echo "[FIX] Found: $db"
        node -e "
        const Database = require('better-sqlite3');
        try {
            const db = new Database('$db', {readonly: true});
            const c = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
            console.log('  - Hearings:', c.count);
            db.close();
        } catch(e) {
            console.log('  - Error:', e.message);
        }
        " 2>&1
    fi
done

# 3. The real problem: server.js is already running with cached modules
echo -e "\n[FIX] The problem: Server is running with cached db/sqlite.js module"
echo "[FIX] Solution: Set DB_PATH environment variable in Render Dashboard"

# 4. Show exact steps
echo -e "\n[FIX] ========================================="
echo "[FIX] SOLUTION:"
echo "[FIX] ========================================="
echo "[FIX] 1. Go to Render Dashboard"
echo "[FIX] 2. Navigate to your service"
echo "[FIX] 3. Click 'Environment' tab"
echo "[FIX] 4. Add this environment variable:"
echo "[FIX]    DB_PATH = /opt/render/project/src/fetcher/data/app.sqlite"
echo "[FIX] 5. Click 'Save Changes'"
echo "[FIX] 6. Service will auto-restart"
echo "[FIX] ========================================="

# 5. Alternative: Force process restart
echo -e "\n[FIX] Alternative (if you have access):"
echo "[FIX] Kill the node process to force restart:"
echo "[FIX] pkill -f 'node.*server.js'"

# 6. Test current status
echo -e "\n[FIX] Current server status:"
curl -s https://blivhort-ai.onrender.com/api/db-status | python3 -m json.tool 2>/dev/null || echo "[FIX] Failed to get status"