#!/usr/bin/env node
// Direct database fix - run this on the Render server via SSH

const fs = require('fs');
const path = require('path');

console.log('[DIRECT FIX] Starting direct database fix...');
console.log('[DIRECT FIX] Current directory:', process.cwd());
console.log('[DIRECT FIX] __dirname:', __dirname);

// First, fix the DB_PATH issue
const correctDbPath = '/opt/render/project/src/fetcher/data/app.sqlite';
process.env.DB_PATH = correctDbPath;

console.log('[DIRECT FIX] Setting DB_PATH to:', correctDbPath);

// Create directory if needed
const dbDir = path.dirname(correctDbPath);
if (!fs.existsSync(dbDir)) {
    console.log('[DIRECT FIX] Creating directory:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
}

// Now load better-sqlite3 directly
let Database;
try {
    Database = require('better-sqlite3');
    console.log('[DIRECT FIX] better-sqlite3 loaded successfully');
} catch (e) {
    console.error('[DIRECT FIX] Failed to load better-sqlite3:', e.message);
    process.exit(1);
}

// Create database
let db;
try {
    db = new Database(correctDbPath);
    console.log('[DIRECT FIX] Database opened at:', correctDbPath);
    
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
    
    console.log('[DIRECT FIX] Tables created');
    
    // Test with sample data
    db.prepare('INSERT OR REPLACE INTO hearings(id, title, status, updated_at) VALUES (?, ?, ?, ?)').run(
        999, 'Test Hearing - Direct Fix', 'Active', Date.now()
    );
    
    const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
    console.log('[DIRECT FIX] Hearings in database:', count.count);
    
} catch (e) {
    console.error('[DIRECT FIX] Database operation failed:', e);
    process.exit(1);
}

// Now fetch some real data
console.log('\n[DIRECT FIX] Fetching real hearing data...');

const axios = require('axios');

async function fetchHearings() {
    try {
        // First, try to get the hearing index from the local server
        console.log('[DIRECT FIX] Trying local server first...');
        
        try {
            const indexResp = await axios.get('http://localhost:3010/api/hearing-index', {
                timeout: 10000,
                validateStatus: () => true
            });
            
            if (indexResp.status === 200 && indexResp.data?.success) {
                const hearings = indexResp.data.hearings || [];
                console.log(`[DIRECT FIX] Got ${hearings.length} hearings from local server`);
                
                const stmt = db.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
                
                for (const h of hearings) {
                    stmt.run(h.id, h.title || `Høring ${h.id}`, h.startDate, h.deadline, h.status || 'Unknown', Date.now());
                }
                
                console.log('[DIRECT FIX] Stored hearings from server index');
                return;
            }
        } catch (e) {
            console.log('[DIRECT FIX] Local server not available, trying external API...');
        }
        
        // Fallback to external API
        const response = await axios.get('https://blivhoert.kk.dk/api/hearing?PageIndex=1&PageSize=100', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        
        if (response.status === 200 && response.data) {
            const items = response.data?.data || [];
            console.log(`[DIRECT FIX] Got ${items.length} items from external API`);
            
            const stmt = db.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
            
            for (const item of items) {
                if (item.type !== 'hearing') continue;
                
                const id = Number(item.id);
                const attrs = item.attributes || {};
                
                stmt.run(
                    id,
                    attrs.esdhTitle || `Høring ${id}`,
                    attrs.startDate,
                    attrs.deadline,
                    'Unknown',
                    Date.now()
                );
            }
            
            console.log('[DIRECT FIX] Stored hearings from external API');
        }
        
    } catch (e) {
        console.error('[DIRECT FIX] Failed to fetch hearings:', e.message);
    }
}

// Fetch and store hearings
fetchHearings().then(() => {
    // Final check
    const finalCount = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
    console.log(`\n[DIRECT FIX] Final hearing count: ${finalCount.count}`);
    
    // Show some samples
    const samples = db.prepare('SELECT id, title, status FROM hearings ORDER BY id DESC LIMIT 5').all();
    console.log('[DIRECT FIX] Sample hearings:');
    samples.forEach(h => {
        console.log(`  - ${h.id}: ${h.title?.substring(0, 50)}... (${h.status})`);
    });
    
    db.close();
    console.log('\n[DIRECT FIX] Database fixed and closed');
    console.log('[DIRECT FIX] The server should now show data!');
    
}).catch(e => {
    console.error('[DIRECT FIX] Fatal error:', e);
    if (db) db.close();
    process.exit(1);
});