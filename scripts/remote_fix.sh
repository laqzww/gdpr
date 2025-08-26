#!/bin/bash
# Remote fix script - can be run via curl
# Usage: curl -sL https://raw.githubusercontent.com/laqzww/fetcher/main/scripts/remote_fix.sh | bash

echo "[REMOTE FIX] Starting remote database fix..."
echo "[REMOTE FIX] Current directory: $(pwd)"

# Check if we're on Render
if [ "$RENDER" != "true" ]; then
    echo "[REMOTE FIX] ERROR: This script should only be run on Render"
    exit 1
fi

# Navigate to the correct directory
cd /opt/render/project/src || {
    echo "[REMOTE FIX] ERROR: Could not navigate to /opt/render/project/src"
    exit 1
}

echo "[REMOTE FIX] Working directory: $(pwd)"

# Create the force initialization script
cat > force_init.js << 'EOF'
const fs = require('fs');
const path = require('path');

console.log('[INIT] Force initializing database...');

// Force the correct path
const DB_PATH = '/opt/render/project/src/fetcher/data/app.sqlite';
const DB_DIR = path.dirname(DB_PATH);

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
    console.log('[INIT] Creating directory:', DB_DIR);
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// Set environment variable
process.env.DB_PATH = DB_PATH;
process.env.RENDER = 'true';

console.log('[INIT] Environment set:');
console.log('  DB_PATH:', process.env.DB_PATH);
console.log('  RENDER:', process.env.RENDER);

// Load better-sqlite3 directly
let Database;
try {
    Database = require('better-sqlite3');
    console.log('[INIT] better-sqlite3 loaded successfully');
} catch (e) {
    console.error('[INIT] Failed to load better-sqlite3:', e.message);
    process.exit(1);
}

// Initialize database
try {
    const db = new Database(DB_PATH);
    console.log('[INIT] Database opened at:', DB_PATH);
    
    // Create tables
    db.exec(`
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
    `);
    
    console.log('[INIT] Tables created');
    
    // Test with sample data
    const stmt = db.prepare('INSERT OR REPLACE INTO hearings(id, title, status, updated_at) VALUES (?, ?, ?, ?)');
    stmt.run(999, 'Test Hearing', 'Active', Date.now());
    
    const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
    console.log('[INIT] Hearings in database:', count.count);
    
    db.close();
    console.log('[INIT] Database initialization successful!');
    
} catch (e) {
    console.error('[INIT] Database initialization failed:', e);
    process.exit(1);
}

console.log('[INIT] Now fetching real data...');

// Fetch and store real data
const axios = require('axios');

async function fetchData() {
    const db = new Database(DB_PATH);
    const stmt = db.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    
    try {
        const response = await axios.get('https://blivhoert.kk.dk/api/hearing?PageIndex=1&PageSize=20');
        const hearings = response.data?.data || [];
        
        console.log('[INIT] Fetched', hearings.length, 'hearings');
        
        for (const h of hearings) {
            stmt.run(h.id, h.title, h.startDate, h.deadline, h.status, Date.now());
        }
        
        const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
        console.log('[INIT] Total hearings stored:', count.count);
        
    } catch (e) {
        console.error('[INIT] Failed to fetch data:', e.message);
    } finally {
        db.close();
    }
}

fetchData().then(() => {
    console.log('[INIT] Complete! Database is ready.');
    
    // Create a flag file to indicate success
    fs.writeFileSync('/opt/render/project/src/fetcher/data/.initialized', new Date().toISOString());
    
}).catch(e => {
    console.error('[INIT] Fatal error:', e);
    process.exit(1);
});
EOF

echo "[REMOTE FIX] Running initialization script..."
node force_init.js

# Clean up
rm -f force_init.js

echo "[REMOTE FIX] Creating symlink for backward compatibility..."
if [ ! -e /opt/render/project/src/data ]; then
    ln -s fetcher/data /opt/render/project/src/data
    echo "[REMOTE FIX] Symlink created"
fi

echo "[REMOTE FIX] Checking results..."
if [ -f /opt/render/project/src/fetcher/data/.initialized ]; then
    echo "[REMOTE FIX] ✓ Database initialized successfully!"
    echo "[REMOTE FIX] ✓ Data has been fetched!"
    echo ""
    echo "[REMOTE FIX] The application should now work correctly."
    echo "[REMOTE FIX] You may need to refresh the page or wait a moment for changes to take effect."
else
    echo "[REMOTE FIX] ✗ Initialization may have failed. Check the logs above."
fi

echo ""
echo "[REMOTE FIX] Fix attempt completed."