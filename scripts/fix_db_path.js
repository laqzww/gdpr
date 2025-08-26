#!/usr/bin/env node
// Fix DB_PATH issue once and for all

const fs = require('fs');
const path = require('path');

console.log('[FIX DB_PATH] Fixing database path issue...');

// 1. Create symlink from ./data to fetcher/data
const dataLink = path.join('/opt/render/project/src/data');
const fetcherData = path.join('/opt/render/project/src/fetcher/data');

if (!fs.existsSync(dataLink)) {
    console.log('[FIX DB_PATH] Creating symlink: ./data -> fetcher/data');
    try {
        fs.symlinkSync('fetcher/data', dataLink);
        console.log('[FIX DB_PATH] Symlink created successfully');
    } catch (e) {
        console.error('[FIX DB_PATH] Failed to create symlink:', e.message);
    }
} else {
    console.log('[FIX DB_PATH] Symlink already exists');
}

// 2. Ensure fetcher/data directory exists
if (!fs.existsSync(fetcherData)) {
    console.log('[FIX DB_PATH] Creating fetcher/data directory');
    fs.mkdirSync(fetcherData, { recursive: true });
}

// 3. Create database in BOTH locations to be sure
const Database = require('better-sqlite3');

const paths = [
    '/opt/render/project/src/data/app.sqlite',
    '/opt/render/project/src/fetcher/data/app.sqlite'
];

for (const dbPath of paths) {
    console.log(`\n[FIX DB_PATH] Initializing database at: ${dbPath}`);
    
    try {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        const db = new Database(dbPath);
        
        // Create all tables
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
              total_materials INTEGER,
              last_success_at INTEGER,
              archived INTEGER DEFAULT 0
            );
            
            CREATE TABLE IF NOT EXISTS responses(
              hearing_id INTEGER,
              response_id TEXT PRIMARY KEY,
              text TEXT,
              author TEXT,
              organization TEXT,
              on_behalf_of TEXT,
              submitted_at TEXT,
              org_name TEXT,
              submitted_date TEXT,
              pdf_url TEXT,
              created_at INTEGER
            );
            
            CREATE TABLE IF NOT EXISTS attachments(
              hearing_id INTEGER,
              response_id TEXT,
              idx INTEGER,
              filename TEXT,
              url TEXT,
              PRIMARY KEY (hearing_id, response_id, idx)
            );
            
            CREATE TABLE IF NOT EXISTS materials(
              hearing_id INTEGER,
              material_id TEXT PRIMARY KEY,
              idx INTEGER,
              type TEXT,
              title TEXT,
              url TEXT,
              content TEXT,
              pdf_url TEXT,
              created_at INTEGER
            );
            
            CREATE INDEX IF NOT EXISTS idx_hearings_status ON hearings(status);
            CREATE INDEX IF NOT EXISTS idx_hearings_archived ON hearings(archived);
            CREATE INDEX IF NOT EXISTS idx_responses_hearing ON responses(hearing_id);
            CREATE INDEX IF NOT EXISTS idx_materials_hearing ON materials(hearing_id);
        `);
        
        // Add test data
        db.prepare('INSERT OR REPLACE INTO hearings(id, title, status, updated_at) VALUES (?, ?, ?, ?)').run(
            9999, 'Test Hearing - DB Path Fixed', 'Active', Date.now()
        );
        
        const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
        console.log(`[FIX DB_PATH] Database at ${dbPath} has ${count.count} hearings`);
        
        db.close();
        
    } catch (e) {
        console.error(`[FIX DB_PATH] Failed for ${dbPath}:`, e.message);
    }
}

// 4. Set environment variable
console.log('\n[FIX DB_PATH] Setting DB_PATH environment variable...');
process.env.DB_PATH = '/opt/render/project/src/fetcher/data/app.sqlite';

// 5. Create a marker file to indicate DB is ready
const markerFile = '/opt/render/project/src/fetcher/data/.db_initialized';
fs.writeFileSync(markerFile, new Date().toISOString());

console.log('\n[FIX DB_PATH] Database path issue fixed!');
console.log('[FIX DB_PATH] Databases created at:');
console.log('  - /opt/render/project/src/data/app.sqlite (via symlink)');
console.log('  - /opt/render/project/src/fetcher/data/app.sqlite (actual location)');

// 6. Now fetch some actual data
console.log('\n[FIX DB_PATH] Fetching initial data...');

const axios = require('axios');

async function fetchInitialData() {
    try {
        // Use the rebuild endpoint on the deployed server
        console.log('[FIX DB_PATH] Triggering index rebuild on server...');
        const rebuildResp = await axios.post('https://blivhort-ai.onrender.com/api/rebuild-index', {}, {
            timeout: 60000,
            validateStatus: () => true
        });
        
        console.log('[FIX DB_PATH] Rebuild response:', rebuildResp.status, rebuildResp.data);
        
        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Check if we got data
        const statusResp = await axios.get('https://blivhort-ai.onrender.com/api/db-status', {
            validateStatus: () => true
        });
        
        if (statusResp.data) {
            console.log('\n[FIX DB_PATH] Current server status:');
            console.log(`  DB Path: ${statusResp.data.dbPath}`);
            console.log(`  DB Exists: ${statusResp.data.dbExists}`);
            console.log(`  Hearings: ${statusResp.data.hearingCount}`);
        }
        
    } catch (e) {
        console.error('[FIX DB_PATH] Failed to fetch data:', e.message);
    }
}

fetchInitialData().then(() => {
    console.log('\n[FIX DB_PATH] All done! Check with:');
    console.log('  curl https://blivhort-ai.onrender.com/api/db-status');
});