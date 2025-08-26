#!/usr/bin/env node
// Force data fetch script for Render
// Can be run directly: node scripts/force_data_fetch.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

console.log('[FORCE FETCH] Starting forced data fetch...');
console.log('[FORCE FETCH] Current directory:', process.cwd());

// Force correct database path
const isRender = process.env.RENDER === 'true';
const DB_PATH = isRender 
    ? '/opt/render/project/src/fetcher/data/app.sqlite'
    : path.join(__dirname, '..', 'data', 'app.sqlite');

process.env.DB_PATH = DB_PATH;
console.log('[FORCE FETCH] Using DB_PATH:', DB_PATH);

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    console.log('[FORCE FETCH] Creating directory:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
}

let db;

try {
    db = new Database(DB_PATH);
    console.log('[FORCE FETCH] Database opened successfully');
    
    // Initialize tables
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
        CREATE INDEX IF NOT EXISTS idx_hearings_status ON hearings(status);
        CREATE INDEX IF NOT EXISTS idx_hearings_archived ON hearings(archived);
        CREATE INDEX IF NOT EXISTS idx_responses_hearing ON responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_materials_hearing ON materials(hearing_id);
    `);
    console.log('[FORCE FETCH] Tables initialized');
} catch (e) {
    console.error('[FORCE FETCH] Database initialization failed:', e);
    process.exit(1);
}

async function fetchAndStoreHearings() {
    try {
        // First, let's check if the server is running locally
        const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3010';
        const isLocal = !process.env.PUBLIC_URL && !isRender;
        
        console.log(`[FORCE FETCH] Using base URL: ${baseUrl}`);
        console.log(`[FORCE FETCH] Is local: ${isLocal}`);
        
        // If we're on Render, start the server in the background
        if (isRender) {
            console.log('[FORCE FETCH] Starting local server instance...');
            const { spawn } = require('child_process');
            const serverProcess = spawn('node', ['server.js'], {
                cwd: '/opt/render/project/src',
                env: { ...process.env, PORT: '3010' },
                detached: true,
                stdio: 'ignore'
            });
            serverProcess.unref();
            
            // Wait for server to start
            console.log('[FORCE FETCH] Waiting for server to start...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // Now use the server's hearing index endpoint
        console.log('[FORCE FETCH] Fetching hearing index from server...');
        
        try {
            const indexResp = await axios.get(`${baseUrl}/api/hearing-index`, {
                timeout: 30000,
                validateStatus: () => true
            });
            
            if (indexResp.status === 200 && indexResp.data?.success && Array.isArray(indexResp.data.hearings)) {
                const hearings = indexResp.data.hearings;
                console.log(`[FORCE FETCH] Got ${hearings.length} hearings from server index`);
                
                // Store all hearings
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) 
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                
                const insertMany = db.transaction((hearings) => {
                    for (const h of hearings) {
                        try {
                            stmt.run(
                                h.id,
                                h.title || `Høring ${h.id}`,
                                h.startDate,
                                h.deadline,
                                h.status || 'Unknown',
                                Date.now()
                            );
                        } catch (e) {
                            console.error(`[FORCE FETCH] Failed to store hearing ${h.id}:`, e.message);
                        }
                    }
                });
                
                insertMany(hearings);
                console.log(`[FORCE FETCH] Stored ${hearings.length} hearings from server index`);
                
                // Now let's fetch detailed data for some active hearings
                const activeHearings = hearings.filter(h => 
                    h.status && (h.status.toLowerCase().includes('aktiv') || h.status.toLowerCase().includes('afventer'))
                ).slice(0, 10);
                
                console.log(`\n[FORCE FETCH] Fetching detailed data for ${activeHearings.length} active hearings...`);
                
                for (const hearing of activeHearings) {
                    try {
                        console.log(`[FORCE FETCH] Fetching details for hearing ${hearing.id}: ${hearing.title?.substring(0, 50)}...`);
                        
                        // Use the prefetch endpoint
                        const prefetchResp = await axios.post(
                            `${baseUrl}/api/prefetch/${hearing.id}?apiOnly=1`,
                            { reason: 'force_fetch' },
                            { 
                                validateStatus: () => true,
                                timeout: 60000
                            }
                        );
                        
                        if (prefetchResp.status === 200) {
                            console.log(`[FORCE FETCH] Successfully prefetched hearing ${hearing.id}`);
                        } else {
                            console.log(`[FORCE FETCH] Failed to prefetch hearing ${hearing.id}: ${prefetchResp.status}`);
                        }
                        
                        // Small delay between requests
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                    } catch (e) {
                        console.error(`[FORCE FETCH] Error prefetching hearing ${hearing.id}:`, e.message);
                    }
                }
                
            } else {
                console.error('[FORCE FETCH] Failed to get hearing index from server:', indexResp.status, indexResp.data);
                
                // Fallback: Try the direct API approach
                console.log('\n[FORCE FETCH] Falling back to direct API approach...');
                await fetchFromAPIDirectly();
            }
            
        } catch (e) {
            console.error('[FORCE FETCH] Error fetching from server:', e.message);
            
            // Fallback: Try the direct API approach
            console.log('\n[FORCE FETCH] Falling back to direct API approach...');
            await fetchFromAPIDirectly();
        }
        
        // Get final statistics
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN title IS NOT NULL AND title != '' AND title NOT LIKE 'Høring %' AND title NOT LIKE '%-%-%' THEN 1 END) as with_proper_titles,
                COUNT(CASE WHEN status LIKE '%aktiv%' OR status LIKE '%Aktiv%' THEN 1 END) as active,
                COUNT(CASE WHEN status LIKE '%afsluttet%' OR status LIKE '%Afsluttet%' THEN 1 END) as completed,
                COUNT(CASE WHEN status LIKE '%afventer%' OR status LIKE '%Afventer%' THEN 1 END) as pending
            FROM hearings
        `).get();
        
        console.log('\n[FORCE FETCH] Final database statistics:');
        console.log(`  - Total hearings: ${stats.total}`);
        console.log(`  - With proper titles: ${stats.with_proper_titles}`);
        console.log(`  - Active: ${stats.active}`);
        console.log(`  - Completed: ${stats.completed}`);
        console.log(`  - Pending: ${stats.pending}`);
        
        // Show some hearings with proper titles
        const withTitles = db.prepare(`
            SELECT id, title, status, deadline 
            FROM hearings 
            WHERE title IS NOT NULL AND title != '' AND title NOT LIKE 'Høring %' AND title NOT LIKE '%-%-%'
            ORDER BY id DESC 
            LIMIT 10
        `).all();
        
        if (withTitles.length > 0) {
            console.log('\n[FORCE FETCH] Hearings with proper titles:');
            withTitles.forEach(h => {
                console.log(`  - ${h.id}: ${h.title.substring(0, 60)}... (${h.status})`);
            });
        } else {
            console.log('\n[FORCE FETCH] WARNING: No hearings with proper titles found!');
            console.log('[FORCE FETCH] This suggests the server needs to fetch the data first.');
        }
        
    } catch (e) {
        console.error('[FORCE FETCH] Error:', e.message);
        console.error(e.stack);
    } finally {
        if (db) {
            db.close();
            console.log('\n[FORCE FETCH] Database closed');
        }
    }
}

async function fetchFromAPIDirectly() {
    // This is the fallback method using direct API access
    console.log('[FORCE FETCH] Attempting direct API fetch...');
    
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    try {
        // Try a simple fetch with minimal processing
        const url = 'https://blivhoert.kk.dk/api/hearing?PageIndex=1&PageSize=100';
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            validateStatus: () => true,
            timeout: 30000
        });
        
        if (response.status === 200 && response.data) {
            const items = response.data?.data || [];
            console.log(`[FORCE FETCH] Got ${items.length} items from API`);
            
            let stored = 0;
            for (const item of items) {
                if (item.type !== 'hearing') continue;
                
                const id = Number(item.id);
                const attrs = item.attributes || {};
                
                // For now, use esdhTitle as title
                const title = attrs.esdhTitle || `Høring ${id}`;
                const status = 'Unknown'; // We'll need to look this up from included
                
                try {
                    stmt.run(id, title, attrs.startDate, attrs.deadline, status, Date.now());
                    stored++;
                } catch (e) {
                    console.error(`[FORCE FETCH] Failed to store hearing ${id}:`, e.message);
                }
            }
            
            console.log(`[FORCE FETCH] Stored ${stored} hearings from direct API`);
        } else {
            console.error('[FORCE FETCH] Direct API fetch failed:', response.status);
        }
        
    } catch (e) {
        console.error('[FORCE FETCH] Direct API error:', e.message);
    }
}

// Run the fetch
fetchAndStoreHearings().then(() => {
    console.log('[FORCE FETCH] Script completed!');
    process.exit(0);
}).catch(e => {
    console.error('[FORCE FETCH] Fatal error:', e);
    process.exit(1);
});