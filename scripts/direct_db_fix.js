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
    
    // Check current data
    const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
    console.log('[DIRECT FIX] Current hearings in database:', count.count);
    
    // Only add test hearing if database is empty
    if (count.count === 0) {
        db.prepare('INSERT OR REPLACE INTO hearings(id, title, status, updated_at) VALUES (?, ?, ?, ?)').run(
            999, 'Test Hearing - Direct Fix', 'Active', Date.now()
        );
    }
    
} catch (e) {
    console.error('[DIRECT FIX] Database operation failed:', e);
    process.exit(1);
}

// Now fetch ALL data from the external API
console.log('\n[DIRECT FIX] Fetching ALL hearing data from blivhoert.kk.dk...');

const axios = require('axios');

async function fetchAllHearings() {
    const baseApi = 'https://blivhoert.kk.dk/api/hearing';
    let page = 1;
    const pageSize = 100;
    let totalFetched = 0;
    let totalStored = 0;
    
    const stmt = db.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    
    console.log('[DIRECT FIX] Starting to fetch pages...');
    
    while (true) {
        try {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            console.log(`[DIRECT FIX] Fetching page ${page}...`);
            
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                    'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                    'Referer': 'https://blivhoert.kk.dk/'
                },
                timeout: 30000,
                validateStatus: () => true
            });
            
            if (response.status !== 200) {
                console.log(`[DIRECT FIX] Page ${page} returned status ${response.status}, stopping`);
                break;
            }
            
            const data = response.data;
            const items = Array.isArray(data?.data) ? data.data : [];
            const included = Array.isArray(data?.included) ? data.included : [];
            
            if (items.length === 0) {
                console.log(`[DIRECT FIX] No more items at page ${page}`);
                break;
            }
            
            console.log(`[DIRECT FIX] Page ${page}: Got ${items.length} items`);
            
            // Build status map from included
            const statusById = new Map();
            for (const inc of included) {
                if (inc?.type === 'hearingStatus' && inc?.attributes?.name) {
                    statusById.set(String(inc.id), inc.attributes.name);
                }
            }
            
            // Process each hearing
            let pageStored = 0;
            for (const item of items) {
                if (item.type !== 'hearing') continue;
                
                const id = Number(item.id);
                const attrs = item.attributes || {};
                
                // Extract title - for now use esdhTitle
                const title = attrs.esdhTitle || attrs.title || `Høring ${id}`;
                
                // Extract status from relationships
                let status = 'Unknown';
                const statusRelId = item.relationships?.hearingStatus?.data?.id;
                if (statusRelId && statusById.has(String(statusRelId))) {
                    status = statusById.get(String(statusRelId));
                }
                
                try {
                    stmt.run(
                        id,
                        title,
                        attrs.startDate || attrs.start_date,
                        attrs.deadline,
                        status,
                        Date.now()
                    );
                    pageStored++;
                    totalStored++;
                } catch (e) {
                    console.error(`[DIRECT FIX] Failed to store hearing ${id}:`, e.message);
                }
                
                totalFetched++;
            }
            
            console.log(`[DIRECT FIX] Page ${page}: Stored ${pageStored} hearings`);
            
            // Check if there are more pages
            const totalPages = data?.meta?.Pagination?.totalPages;
            if (totalPages && page >= totalPages) {
                console.log(`[DIRECT FIX] Reached last page (${totalPages})`);
                break;
            }
            
            page++;
            
            // Small delay to avoid rate limiting
            if (page % 5 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Safety limit
            if (page > 50) {
                console.log('[DIRECT FIX] Reached safety limit of 50 pages');
                break;
            }
            
        } catch (e) {
            console.error(`[DIRECT FIX] Error on page ${page}:`, e.message);
            // Try one more time
            if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') {
                console.log('[DIRECT FIX] Network error, waiting 5 seconds and retrying...');
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            break;
        }
    }
    
    console.log(`\n[DIRECT FIX] Fetching complete!`);
    console.log(`[DIRECT FIX] Total hearings fetched: ${totalFetched}`);
    console.log(`[DIRECT FIX] Total hearings stored: ${totalStored}`);
    
    // Now let's try to get better titles from the server if it's running
    console.log('\n[DIRECT FIX] Checking if we can get better titles from the server...');
    try {
        const indexResp = await axios.get('http://localhost:3010/api/hearing-index', {
            timeout: 5000,
            validateStatus: () => true
        });
        
        if (indexResp.status === 200 && indexResp.data?.success) {
            const serverHearings = indexResp.data.hearings || [];
            console.log(`[DIRECT FIX] Got ${serverHearings.length} hearings from server with potentially better titles`);
            
            const updateStmt = db.prepare('UPDATE hearings SET title = ? WHERE id = ? AND (title LIKE ? OR title LIKE ?)');
            let updated = 0;
            
            for (const h of serverHearings) {
                if (h.title && !h.title.includes('-') && h.title !== `Høring ${h.id}`) {
                    const result = updateStmt.run(h.title, h.id, '%-%-%', `Høring ${h.id}`);
                    if (result.changes > 0) updated++;
                }
            }
            
            console.log(`[DIRECT FIX] Updated ${updated} titles from server`);
        }
    } catch (e) {
        console.log('[DIRECT FIX] Server not available for title updates');
    }
}

// Fetch and store hearings
fetchAllHearings().then(() => {
    // Final statistics
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN title NOT LIKE '%-%-%' AND title NOT LIKE 'Høring %' THEN 1 END) as with_proper_titles,
            COUNT(CASE WHEN status LIKE '%aktiv%' OR status LIKE '%Aktiv%' THEN 1 END) as active,
            COUNT(CASE WHEN status LIKE '%afsluttet%' OR status LIKE '%Afsluttet%' THEN 1 END) as completed,
            COUNT(CASE WHEN status LIKE '%afventer%' OR status LIKE '%Afventer%' THEN 1 END) as pending
        FROM hearings
    `).get();
    
    console.log('\n[DIRECT FIX] Final database statistics:');
    console.log(`  - Total hearings: ${stats.total}`);
    console.log(`  - With proper titles: ${stats.with_proper_titles}`);
    console.log(`  - Active: ${stats.active}`);
    console.log(`  - Completed: ${stats.completed}`);
    console.log(`  - Pending: ${stats.pending}`);
    
    // Show samples of different statuses
    console.log('\n[DIRECT FIX] Sample hearings by status:');
    
    const activeHearings = db.prepare(`
        SELECT id, title, status, deadline 
        FROM hearings 
        WHERE status LIKE '%aktiv%' OR status LIKE '%Aktiv%'
        ORDER BY id DESC 
        LIMIT 3
    `).all();
    
    if (activeHearings.length > 0) {
        console.log('\nActive hearings:');
        activeHearings.forEach(h => {
            console.log(`  - ${h.id}: ${h.title?.substring(0, 50)}... (${h.status})`);
        });
    }
    
    const pendingHearings = db.prepare(`
        SELECT id, title, status, deadline 
        FROM hearings 
        WHERE status LIKE '%afventer%' OR status LIKE '%Afventer%'
        ORDER BY id DESC 
        LIMIT 3
    `).all();
    
    if (pendingHearings.length > 0) {
        console.log('\nPending hearings:');
        pendingHearings.forEach(h => {
            console.log(`  - ${h.id}: ${h.title?.substring(0, 50)}... (${h.status})`);
        });
    }
    
    db.close();
    console.log('\n[DIRECT FIX] Database fixed and closed');
    console.log('[DIRECT FIX] The server should now show data!');
    console.log('\n[DIRECT FIX] Test it with:');
    console.log('  curl https://blivhort-ai.onrender.com/api/db-status');
    
}).catch(e => {
    console.error('[DIRECT FIX] Fatal error:', e);
    if (db) db.close();
    process.exit(1);
});