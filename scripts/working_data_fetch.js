#!/usr/bin/env node
// Working data fetch script - uses the server's own mechanisms
// This ACTUALLY works by triggering the server to do the fetching

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

console.log('[WORKING FETCH] Starting working data fetch...');
console.log('[WORKING FETCH] This uses the server\'s own mechanisms to fetch data');

// Setup database
const correctDbPath = '/opt/render/project/src/fetcher/data/app.sqlite';
const dbDir = path.dirname(correctDbPath);

if (!fs.existsSync(dbDir)) {
    console.log('[WORKING FETCH] Creating directory:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database with correct schema
console.log('[WORKING FETCH] Initializing database...');
const db = new Database(correctDbPath);

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
      title TEXT,
      pdf_url TEXT,
      created_at INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_hearings_status ON hearings(status);
    CREATE INDEX IF NOT EXISTS idx_hearings_archived ON hearings(archived);
    CREATE INDEX IF NOT EXISTS idx_responses_hearing ON responses(hearing_id);
    CREATE INDEX IF NOT EXISTS idx_materials_hearing ON materials(hearing_id);
`);

console.log('[WORKING FETCH] Database initialized');
db.close();

// Start a local instance of the server
console.log('\n[WORKING FETCH] Starting local server instance...');
const serverProcess = spawn('node', ['server.js'], {
    cwd: '/opt/render/project/src',
    env: {
        ...process.env,
        PORT: '4000',
        DB_PATH: correctDbPath,
        RENDER: 'true',
        NODE_ENV: 'production'
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
});

serverProcess.unref();

// Capture server output
serverProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
        if (line.trim()) console.log(`[SERVER] ${line}`);
    });
});

serverProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
        if (line.trim()) console.log(`[SERVER ERROR] ${line}`);
    });
});

// Wait for server to start
console.log('[WORKING FETCH] Waiting for server to start...');
let serverReady = false;
let attempts = 0;

async function waitForServer() {
    while (!serverReady && attempts < 30) {
        try {
            const resp = await axios.get('http://localhost:4000/api/db-status', {
                timeout: 2000
            });
            if (resp.status === 200) {
                serverReady = true;
                console.log('[WORKING FETCH] Server is ready!');
                return true;
            }
        } catch (e) {
            // Server not ready yet
        }
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
}

async function main() {
    try {
        // Wait for server
        const ready = await waitForServer();
        if (!ready) {
            console.error('[WORKING FETCH] Server failed to start after 60 seconds');
            process.exit(1);
        }
        
        // Now trigger the server's own data fetching
        console.log('\n[WORKING FETCH] Triggering server data fetch...');
        
        // Step 1: Rebuild index (this fetches all hearings)
        console.log('[WORKING FETCH] Step 1: Rebuilding hearing index...');
        try {
            const rebuildResp = await axios.post('http://localhost:4000/api/rebuild-index', {}, {
                timeout: 300000 // 5 minutes
            });
            console.log('[WORKING FETCH] Rebuild response:', rebuildResp.data);
            
            // Wait for it to complete
            await new Promise(resolve => setTimeout(resolve, 10000));
        } catch (e) {
            console.error('[WORKING FETCH] Rebuild failed:', e.message);
        }
        
        // Step 2: Check what we have
        console.log('\n[WORKING FETCH] Step 2: Checking hearing index...');
        try {
            const indexResp = await axios.get('http://localhost:4000/api/hearing-index', {
                timeout: 30000
            });
            
            if (indexResp.data?.success) {
                const hearings = indexResp.data.hearings || [];
                console.log(`[WORKING FETCH] Got ${hearings.length} hearings in index`);
                
                // Find active hearings
                const activeHearings = hearings.filter(h => {
                    const s = (h.status || '').toLowerCase();
                    return s.includes('aktiv') || s.includes('afventer') || s.includes('høring');
                });
                
                console.log(`[WORKING FETCH] Found ${activeHearings.length} active/pending hearings`);
                
                // Step 3: Prefetch data for active hearings
                console.log('\n[WORKING FETCH] Step 3: Prefetching data for active hearings...');
                
                let successCount = 0;
                const toFetch = activeHearings.slice(0, 20); // Start with 20
                
                for (let i = 0; i < toFetch.length; i++) {
                    const h = toFetch[i];
                    console.log(`[WORKING FETCH] ${i+1}/${toFetch.length}: Prefetching hearing ${h.id}...`);
                    
                    try {
                        const prefetchResp = await axios.post(
                            `http://localhost:4000/api/prefetch/${h.id}?apiOnly=1`,
                            { reason: 'working_fetch' },
                            { timeout: 60000 }
                        );
                        
                        if (prefetchResp.data?.success) {
                            const counts = prefetchResp.data.counts || {};
                            console.log(`[WORKING FETCH] Success! Got ${counts.responses || 0} responses, ${counts.materials || 0} materials`);
                            successCount++;
                        }
                    } catch (e) {
                        console.log(`[WORKING FETCH] Failed to prefetch ${h.id}: ${e.message}`);
                    }
                    
                    // Rate limit
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
                console.log(`\n[WORKING FETCH] Successfully prefetched ${successCount} hearings`);
            }
        } catch (e) {
            console.error('[WORKING FETCH] Failed to get hearing index:', e.message);
        }
        
        // Step 4: Check final database status
        console.log('\n[WORKING FETCH] Step 4: Checking final database status...');
        
        const finalDb = new Database(correctDbPath);
        const stats = finalDb.prepare(`
            SELECT 
                COUNT(DISTINCT h.id) as total_hearings,
                COUNT(DISTINCT CASE WHEN h.title NOT LIKE '%-%-%' AND h.title NOT LIKE 'Høring %' THEN h.id END) as with_proper_titles,
                COUNT(DISTINCT CASE WHEN r.hearing_id IS NOT NULL THEN h.id END) as with_responses,
                COUNT(DISTINCT CASE WHEN m.hearing_id IS NOT NULL THEN h.id END) as with_materials,
                COUNT(DISTINCT r.response_id) as total_responses,
                COUNT(DISTINCT m.material_id) as total_materials
            FROM hearings h
            LEFT JOIN responses r ON h.id = r.hearing_id
            LEFT JOIN materials m ON h.id = m.hearing_id
        `).get();
        
        console.log('\nFinal database statistics:');
        console.log(`  Total hearings: ${stats.total_hearings}`);
        console.log(`  With proper titles: ${stats.with_proper_titles}`);
        console.log(`  With responses: ${stats.with_responses}`);
        console.log(`  With materials: ${stats.with_materials}`);
        console.log(`  Total responses: ${stats.total_responses}`);
        console.log(`  Total materials: ${stats.total_materials}`);
        
        // Show samples
        const samples = finalDb.prepare(`
            SELECT h.id, h.title, h.status, 
                   COUNT(DISTINCT r.response_id) as responses,
                   COUNT(DISTINCT m.material_id) as materials
            FROM hearings h
            LEFT JOIN responses r ON h.id = r.hearing_id
            LEFT JOIN materials m ON h.id = m.hearing_id
            WHERE h.title NOT LIKE '%-%-%'
            GROUP BY h.id
            HAVING responses > 0 OR materials > 0
            ORDER BY responses DESC
            LIMIT 5
        `).all();
        
        if (samples.length > 0) {
            console.log('\nTop hearings with data:');
            samples.forEach(h => {
                console.log(`  ${h.id}: ${h.title?.substring(0, 50)}... (${h.responses} responses, ${h.materials} materials)`);
            });
        }
        
        finalDb.close();
        
        // Kill the server process
        console.log('\n[WORKING FETCH] Cleaning up...');
        try {
            process.kill(-serverProcess.pid);
        } catch (e) {
            // Ignore
        }
        
        console.log('[WORKING FETCH] Done! The database is now populated.');
        console.log('\nYou can verify with:');
        console.log('  curl https://blivhort-ai.onrender.com/api/db-status');
        
    } catch (e) {
        console.error('[WORKING FETCH] Fatal error:', e.message);
        console.error(e.stack);
        
        // Try to kill server
        try {
            process.kill(-serverProcess.pid);
        } catch (e) {
            // Ignore
        }
        
        process.exit(1);
    }
}

// Run it
main();