#!/usr/bin/env node
// Force server to use existing database

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('[FORCE] Starting force server to work script...');

// 1. First, let's check what databases exist and their content
console.log('\n[FORCE] Step 1: Checking existing databases...');

const dbPaths = [
    '/opt/render/project/src/data/app.sqlite',
    '/opt/render/project/src/fetcher/data/app.sqlite',
    './data/app.sqlite',
    './fetcher/data/app.sqlite'
];

let workingDbPath = null;
let maxHearings = 0;

// Test better-sqlite3 first
try {
    console.log('[FORCE] Testing better-sqlite3...');
    const testResult = execSync('node -e "console.log(require(\'better-sqlite3\'))"', { encoding: 'utf8' });
    console.log('[FORCE] better-sqlite3 is available');
} catch (e) {
    console.error('[FORCE] better-sqlite3 test failed:', e.message);
    
    // Try to rebuild it
    console.log('[FORCE] Attempting to rebuild better-sqlite3...');
    try {
        execSync('npm rebuild better-sqlite3 --update-binary', { stdio: 'inherit' });
        console.log('[FORCE] Rebuild completed');
    } catch (e) {
        console.error('[FORCE] Rebuild failed:', e.message);
    }
}

// Now check databases
const Database = require('better-sqlite3');

for (const dbPath of dbPaths) {
    try {
        const absPath = path.resolve(dbPath);
        if (fs.existsSync(absPath)) {
            console.log(`\n[FORCE] Found database at: ${absPath}`);
            const db = new Database(absPath, { readonly: true });
            const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
            console.log(`[FORCE]   - Contains ${count.count} hearings`);
            
            if (count.count > maxHearings) {
                maxHearings = count.count;
                workingDbPath = absPath;
            }
            
            // Show sample
            const sample = db.prepare('SELECT id, title, status FROM hearings LIMIT 3').all();
            sample.forEach(h => {
                console.log(`[FORCE]   - ${h.id}: ${h.title?.substring(0, 40)}... (${h.status})`);
            });
            
            db.close();
        }
    } catch (e) {
        console.log(`[FORCE] Failed to read ${dbPath}: ${e.message}`);
    }
}

if (!workingDbPath) {
    console.error('[FORCE] No working database found!');
    process.exit(1);
}

console.log(`\n[FORCE] Best database: ${workingDbPath} with ${maxHearings} hearings`);

// 2. Create a wrapper script that forces the correct DB_PATH
console.log('\n[FORCE] Step 2: Creating server wrapper...');

const wrapperScript = `#!/usr/bin/env node
// Server wrapper that forces correct DB_PATH

process.env.DB_PATH = '${workingDbPath}';
process.env.RENDER = 'true';
process.env.NODE_ENV = 'production';

console.log('[WRAPPER] Starting server with DB_PATH:', process.env.DB_PATH);

// Load the database module first to ensure it works
try {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
    console.log('[WRAPPER] Database test successful, found', count.count, 'hearings');
    db.close();
} catch (e) {
    console.error('[WRAPPER] Database test failed:', e.message);
}

// Now start the server
require('./server.js');
`;

fs.writeFileSync('/opt/render/project/src/server_wrapper.js', wrapperScript);
console.log('[FORCE] Wrapper created at server_wrapper.js');

// 3. Create a test endpoint that bypasses db/sqlite.js
console.log('\n[FORCE] Step 3: Creating direct database test endpoint...');

const testEndpoint = `
const express = require('express');
const Database = require('better-sqlite3');
const app = express();

app.get('/api/direct-db-test', (req, res) => {
    try {
        const db = new Database('${workingDbPath}', { readonly: true });
        const stats = db.prepare(\`
            SELECT 
                COUNT(*) as total_hearings,
                COUNT(DISTINCT CASE WHEN r.hearing_id IS NOT NULL THEN h.id END) as with_responses,
                COUNT(DISTINCT r.response_id) as total_responses
            FROM hearings h
            LEFT JOIN responses r ON h.id = r.hearing_id
        \`).get();
        
        const samples = db.prepare('SELECT id, title, status FROM hearings LIMIT 5').all();
        
        db.close();
        
        res.json({
            success: true,
            dbPath: '${workingDbPath}',
            stats,
            samples
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(5000, () => {
    console.log('[TEST] Direct DB test endpoint running on port 5000');
    console.log('[TEST] Test with: curl http://localhost:5000/api/direct-db-test');
});
`;

fs.writeFileSync('/opt/render/project/src/test_direct_db.js', testEndpoint);

// 4. Start the test endpoint
console.log('\n[FORCE] Step 4: Starting direct database test server...');
const { spawn } = require('child_process');
const testProcess = spawn('node', ['test_direct_db.js'], {
    cwd: '/opt/render/project/src',
    detached: true,
    stdio: 'ignore'
});
testProcess.unref();

console.log('[FORCE] Waiting for test server to start...');
setTimeout(() => {
    // 5. Test it
    console.log('\n[FORCE] Step 5: Testing direct database access...');
    try {
        const result = execSync('curl -s http://localhost:5000/api/direct-db-test', { encoding: 'utf8' });
        console.log('[FORCE] Direct DB test result:', result);
    } catch (e) {
        console.error('[FORCE] Direct DB test failed:', e.message);
    }
    
    // Continue with final instructions
    printFinalInstructions();
}, 3000);

function printFinalInstructions() {
    // 6. Final instructions
    console.log('\n[FORCE] ========================================');
    console.log('[FORCE] SOLUTION:');
    console.log('[FORCE] ========================================');
    console.log('[FORCE] The database EXISTS and has data!');
    console.log(`[FORCE] Database location: ${workingDbPath}`);
    console.log(`[FORCE] Database contains: ${maxHearings} hearings`);
    console.log('[FORCE]');
    console.log('[FORCE] The problem is that db/sqlite.js fails to load better-sqlite3');
    console.log('[FORCE] or the server is not using the correct DB_PATH.');
    console.log('[FORCE]');
    console.log('[FORCE] IMMEDIATE FIX:');
    console.log('[FORCE] 1. Restart the Render service to force it to reload');
    console.log('[FORCE] 2. Or manually set DB_PATH in Render environment variables to:');
    console.log(`[FORCE]    DB_PATH=${workingDbPath}`);
    console.log('[FORCE]');
    console.log('[FORCE] The test endpoint proves the database works:');
    console.log('[FORCE]   curl http://localhost:5000/api/direct-db-test');
    console.log('[FORCE] ========================================');
    
    // Kill any hanging processes
    try {
        execSync('pkill -f test_direct_db.js', { stdio: 'ignore' });
    } catch (e) {
        // Ignore
    }
}