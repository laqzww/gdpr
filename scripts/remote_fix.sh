#!/bin/bash
# Remote fix script for Render database issues
# Can be run via SSH: bash scripts/remote_fix.sh

set -e

echo "[REMOTE FIX] Starting database fix..."
echo "[REMOTE FIX] Current directory: $(pwd)"
echo "[REMOTE FIX] User: $(whoami)"

# Navigate to correct directory
cd /opt/render/project/src

# Create symlink if needed
if [ ! -e "/opt/render/project/src/data" ]; then
    echo "[REMOTE FIX] Creating data symlink..."
    ln -s fetcher/data /opt/render/project/src/data
fi

# Set environment variables
export DB_PATH="/opt/render/project/src/fetcher/data/app.sqlite"
export NODE_ENV="production"
export RENDER="true"

echo "[REMOTE FIX] DB_PATH: $DB_PATH"

# Create directory if needed
mkdir -p $(dirname "$DB_PATH")

# Run node script to initialize and populate database
node -e "
const Database = require('better-sqlite3');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

console.log('[INIT] Starting database initialization...');
const DB_PATH = process.env.DB_PATH || '/opt/render/project/src/fetcher/data/app.sqlite';

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

console.log('[INIT] Using database path:', DB_PATH);

try {
    const db = new Database(DB_PATH);
    console.log('[INIT] Database opened successfully');
    
    // Create tables
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
    \`);
    
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
        console.log('[INIT] Starting to fetch ALL hearings...');
        let page = 1;
        let totalFetched = 0;
        const pageSize = 100;
        
        while (true) {
            const url = \`https://blivhoert.kk.dk/api/hearing?PageIndex=\${page}&PageSize=\${pageSize}\`;
            const response = await axios.get(url, { validateStatus: () => true });
            
            if (response.status !== 200 || !response.data) break;
            
            const data = response.data;
            const items = data?.data || [];
            const included = data?.included || [];
            
            if (items.length === 0) break;
            
            // Build maps for lookups
            const titleByContentId = new Map();
            const statusById = new Map();
            
            // Extract titles from content
            for (const inc of included) {
                if (inc?.type === 'content') {
                    const fieldId = inc?.relationships?.field?.data?.id;
                    if (String(fieldId) === '1' && inc?.attributes?.textContent) {
                        titleByContentId.set(String(inc.id), String(inc.attributes.textContent).trim());
                    }
                }
                if (inc?.type === 'hearingStatus' && inc?.attributes?.name) {
                    statusById.set(String(inc.id), inc.attributes.name);
                }
            }
            
            console.log(\`[INIT] Page \${page}: Fetched \${items.length} hearings\`);
            
            for (const item of items) {
                if (item.type !== 'hearing') continue;
                
                const hId = Number(item.id);
                const attrs = item.attributes || {};
                
                // Extract title
                let title = '';
                const contentRels = (item.relationships?.contents?.data) || [];
                for (const cref of contentRels) {
                    const cid = cref?.id && String(cref.id);
                    if (cid && titleByContentId.has(cid)) {
                        title = titleByContentId.get(cid);
                        break;
                    }
                }
                
                if (!title) {
                    title = attrs.esdhTitle || \`Høring \${hId}\`;
                }
                
                // Extract status
                const statusRelId = item.relationships?.hearingStatus?.data?.id;
                const status = statusRelId && statusById.has(String(statusRelId)) 
                    ? statusById.get(String(statusRelId))
                    : 'Unknown';
                
                stmt.run(hId, title, attrs.startDate, attrs.deadline, status, Date.now());
                totalFetched++;
            }
            
            page++;
            if (page % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
            }
        }
        
        console.log(\`[INIT] Fetched total of \${totalFetched} hearings from \${page - 1} pages\`);
        
        const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
        console.log('[INIT] Total hearings stored:', count.count);
        
        const samples = db.prepare('SELECT id, title, status FROM hearings WHERE title NOT LIKE \"Høring %\" LIMIT 5').all();
        console.log('[INIT] Sample hearings with titles:');
        samples.forEach(h => {
            console.log(\`  \${h.id}: \${h.title?.substring(0, 50)}... (\${h.status})\`);
        });
        
        db.close();
        console.log('[INIT] Data fetch completed successfully!');
        
    } catch (e) {
        console.error('[INIT] Data fetch failed:', e.message);
        db.close();
        process.exit(1);
    }
}

fetchData().catch(e => {
    console.error('[INIT] Fatal error:', e);
    process.exit(1);
});
"

echo "[REMOTE FIX] Database fix completed!"
echo "[REMOTE FIX] You can now check the status at: https://blivhort-ai.onrender.com/api/db-status"