#!/usr/bin/env node
// Ultimate DB fix - patches db/sqlite.js directly

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('[ULTIMATE FIX] Starting ultimate database fix...');

// 1. Find the working database
console.log('\n[ULTIMATE FIX] Step 1: Finding working database...');

let workingDbPath = null;
let maxHearings = 0;

// Test with node directly to avoid module issues
const testScript = `
const Database = require('better-sqlite3');
const paths = [
    '/opt/render/project/src/fetcher/data/app.sqlite',
    '/opt/render/project/src/data/app.sqlite'
];

for (const p of paths) {
    try {
        const db = new Database(p, { readonly: true });
        const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
        console.log(JSON.stringify({ path: p, count: count.count }));
        db.close();
    } catch (e) {
        console.log(JSON.stringify({ path: p, error: e.message }));
    }
}
`;

try {
    const output = execSync(`node -e "${testScript.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    for (const line of lines) {
        try {
            const data = JSON.parse(line);
            if (data.count && data.count > maxHearings) {
                maxHearings = data.count;
                workingDbPath = data.path;
            }
        } catch (e) {}
    }
} catch (e) {
    console.error('[ULTIMATE FIX] Database test failed:', e.message);
}

if (!workingDbPath) {
    console.error('[ULTIMATE FIX] No working database found!');
    process.exit(1);
}

console.log(`[ULTIMATE FIX] Found working database: ${workingDbPath} with ${maxHearings} hearings`);

// 2. Create a patched version of db/sqlite.js
console.log('\n[ULTIMATE FIX] Step 2: Creating patched db/sqlite.js...');

const patchedSqlite = `// PATCHED VERSION - Forces correct database path
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Force the correct database path
const DB_PATH = '${workingDbPath}';

console.log('[SQLite] Using forced DB_PATH:', DB_PATH);

let db = null;

function init() {
    console.log('[SQLite] Initializing with forced path...');
    
    if (!db) {
        db = new Database(DB_PATH);
        console.log('[SQLite] Database opened successfully');
        
        try { db.pragma('journal_mode = WAL'); } catch (_) {}
        
        // Initialize tables
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
              total_materials INTEGER,
              last_success_at INTEGER,
              archived INTEGER
            );
            CREATE TABLE IF NOT EXISTS responses(
              hearing_id INTEGER,
              response_id INTEGER,
              text TEXT,
              author TEXT,
              organization TEXT,
              created_at TEXT,
              cpr_anonymized INTEGER,
              cvr_anonymized INTEGER,
              UNIQUE(hearing_id, response_id)
            );
            CREATE TABLE IF NOT EXISTS materials(
              hearing_id INTEGER,
              material_id INTEGER,
              title TEXT,
              url TEXT,
              type TEXT,
              created_at TEXT,
              UNIQUE(hearing_id, material_id)
            );
            CREATE TABLE IF NOT EXISTS search_index(
              hearing_id INTEGER PRIMARY KEY,
              content TEXT,
              updated_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_hearings_status ON hearings(status);
            CREATE INDEX IF NOT EXISTS idx_hearings_deadline ON hearings(deadline);
            CREATE INDEX IF NOT EXISTS idx_responses_hearing ON responses(hearing_id);
            CREATE INDEX IF NOT EXISTS idx_materials_hearing ON materials(hearing_id);
        \`);
        
        console.log('[SQLite] Tables initialized');
    }
    return db;
}

// Auto-initialize
init();

module.exports = { db, init, DB_PATH };
`;

// Backup original
const originalPath = '/opt/render/project/src/db/sqlite.js';
const backupPath = '/opt/render/project/src/db/sqlite.js.backup';

if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(originalPath, backupPath);
    console.log('[ULTIMATE FIX] Original backed up to sqlite.js.backup');
}

// Write patched version
fs.writeFileSync(originalPath, patchedSqlite);
console.log('[ULTIMATE FIX] Patched db/sqlite.js written');

// 3. Test the patch
console.log('\n[ULTIMATE FIX] Step 3: Testing the patch...');

try {
    const testResult = execSync('node -e "const {db} = require(\'./db/sqlite.js\'); console.log(db.prepare(\'SELECT COUNT(*) as count FROM hearings\').get())"', { 
        cwd: '/opt/render/project/src',
        encoding: 'utf8' 
    });
    console.log('[ULTIMATE FIX] Test result:', testResult.trim());
} catch (e) {
    console.error('[ULTIMATE FIX] Test failed:', e.message);
}

// 4. Force server restart
console.log('\n[ULTIMATE FIX] Step 4: Testing server endpoints...');

// Test db-reinit
try {
    const reinitResult = execSync('curl -s -X POST https://blivhort-ai.onrender.com/api/db-reinit', { encoding: 'utf8' });
    console.log('[ULTIMATE FIX] DB reinit result:', reinitResult);
} catch (e) {
    console.error('[ULTIMATE FIX] DB reinit failed:', e.message);
}

// Wait a bit
setTimeout(() => {
    // Test db-status
    try {
        const statusResult = execSync('curl -s https://blivhort-ai.onrender.com/api/db-status', { encoding: 'utf8' });
        console.log('[ULTIMATE FIX] DB status result:', statusResult);
        
        const status = JSON.parse(statusResult);
        if (status.dbExists && status.hearingCount > 0) {
            console.log('\n[ULTIMATE FIX] ========================================');
            console.log('[ULTIMATE FIX] SUCCESS! Database is now working!');
            console.log('[ULTIMATE FIX] ========================================');
            console.log(`[ULTIMATE FIX] Database path: ${status.dbPath}`);
            console.log(`[ULTIMATE FIX] Hearings: ${status.hearingCount}`);
            console.log(`[ULTIMATE FIX] Responses: ${status.responseCount}`);
            console.log(`[ULTIMATE FIX] Materials: ${status.materialCount}`);
            console.log('[ULTIMATE FIX] ========================================');
        } else {
            console.log('\n[ULTIMATE FIX] Server still not seeing the database.');
            console.log('[ULTIMATE FIX] You may need to restart the Render service.');
        }
    } catch (e) {
        console.error('[ULTIMATE FIX] Status check failed:', e.message);
    }
    
    console.log('\n[ULTIMATE FIX] Done!');
}, 2000);