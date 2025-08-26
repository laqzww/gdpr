#!/usr/bin/env node
// Force data fetch script for Render
// Can be run directly: node scripts/force_data_fetch.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

// Load database module with forced path
const Database = require('better-sqlite3');
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
        console.log('[FORCE FETCH] Fetching ALL hearings from API...');
        const baseApi = 'https://blivhoert.kk.dk/api/hearing';
        let page = 1;
        const pageSize = 100;
        let totalStored = 0;
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;
        
        // Prepare statement outside loop for efficiency
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        
        console.log('[FORCE FETCH] Starting to fetch all pages...');
        
        while (true) {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            
            try {
                // Show progress every 5 pages
                if (page % 5 === 1) {
                    console.log(`[FORCE FETCH] Progress: Fetching page ${page} (${totalStored} hearings stored so far)...`);
                }
                
                const response = await axios.get(url, { 
                    validateStatus: () => true,
                    timeout: 30000 
                });
                
                if (response.status !== 200 || !response.data) {
                    console.log(`[FORCE FETCH] No more pages (page ${page}, status: ${response.status})`);
                    break;
                }
                
                const data = response.data;
                const items = Array.isArray(data?.data) ? data.data : [];
                const included = Array.isArray(data?.included) ? data.included : [];
                
                if (items.length === 0) {
                    console.log(`[FORCE FETCH] No more items at page ${page}`);
                    break;
                }
                
                // Build a map of content IDs to titles
                const titleByContentId = new Map();
                for (const inc of included) {
                    if (inc?.type === 'content') {
                        const fieldId = inc?.relationships?.field?.data?.id;
                        // Field ID 1 seems to be the title field
                        if (String(fieldId) === '1' && typeof inc?.attributes?.textContent === 'string') {
                            titleByContentId.set(String(inc.id), String(inc.attributes.textContent).trim());
                        }
                    }
                }
                
                // Build a map of status IDs to status names
                const statusById = new Map();
                for (const inc of included) {
                    if (inc?.type === 'hearingStatus' && inc?.attributes?.name) {
                        statusById.set(String(inc.id), inc.attributes.name);
                    }
                }
                
                // Process each hearing
                const hearingsToStore = [];
                for (const item of items) {
                    if (!item || item.type !== 'hearing') continue;
                    
                    const hId = Number(item.id);
                    const attrs = item.attributes || {};
                    
                    // Extract title from content relationships
                    let title = '';
                    const contentRels = (item.relationships?.contents?.data) || [];
                    for (const cref of contentRels) {
                        const cid = cref?.id && String(cref.id);
                        if (cid && titleByContentId.has(cid)) {
                            title = titleByContentId.get(cid);
                            break;
                        }
                    }
                    
                    // If no title found in contents, try other fields
                    if (!title) {
                        title = attrs.esdhTitle || `Høring ${hId}`;
                    }
                    
                    // Extract status
                    const statusRelId = item.relationships?.hearingStatus?.data?.id;
                    const status = statusRelId && statusById.has(String(statusRelId)) 
                        ? statusById.get(String(statusRelId))
                        : 'Unknown';
                    
                    hearingsToStore.push({
                        id: hId,
                        title: title,
                        startDate: attrs.startDate || null,
                        deadline: attrs.deadline || null,
                        status: status,
                        timestamp: Date.now()
                    });
                }
                
                // Store hearings in a transaction
                const insertMany = db.transaction((hearings) => {
                    for (const hearing of hearings) {
                        try {
                            stmt.run(
                                hearing.id,
                                hearing.title,
                                hearing.startDate,
                                hearing.deadline,
                                hearing.status,
                                hearing.timestamp
                            );
                            totalStored++;
                        } catch (e) {
                            console.error(`[FORCE FETCH] Failed to store hearing ${hearing.id}:`, e.message);
                        }
                    }
                });
                
                insertMany(hearingsToStore);
                
                console.log(`[FORCE FETCH] Page ${page}: Processed ${hearingsToStore.length} hearings (${hearingsToStore.filter(h => h.title && h.title !== `Høring ${h.id}`).length} with titles)`);
                
                // Check pagination
                const totalPages = data?.meta?.Pagination?.totalPages || page;
                if (page >= totalPages) {
                    console.log(`[FORCE FETCH] Reached last page (${totalPages})`);
                    break;
                }
                
                consecutiveErrors = 0;
                page++;
                
                // Small delay to avoid overwhelming the API
                if (page % 10 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
            } catch (e) {
                consecutiveErrors++;
                console.error(`[FORCE FETCH] Error on page ${page} (attempt ${consecutiveErrors}):`, e.message);
                
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    console.error(`[FORCE FETCH] Too many consecutive errors, stopping at page ${page}`);
                    break;
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log(`\n[FORCE FETCH] Completed! Stored ${totalStored} hearings from ${page - 1} pages`);
        
        // Now backfill missing titles by fetching individual hearing pages
        const missingTitles = db.prepare(`
            SELECT id FROM hearings 
            WHERE (title IS NULL OR title = '' OR title LIKE 'Høring %')
            LIMIT 100
        `).all();
        
        if (missingTitles.length > 0) {
            console.log(`\n[FORCE FETCH] Found ${missingTitles.length} hearings without proper titles. Attempting to backfill...`);
            
            const updateStmt = db.prepare('UPDATE hearings SET title = ? WHERE id = ?');
            let backfilled = 0;
            
            for (const hearing of missingTitles) {
                try {
                    // Try to fetch the HTML page and extract title from __NEXT_DATA__
                    const htmlUrl = `https://blivhoert.kk.dk/offentlig-hoering/${hearing.id}`;
                    const htmlResp = await axios.get(htmlUrl, {
                        validateStatus: () => true,
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                    
                    if (htmlResp.status === 200 && htmlResp.data) {
                        const match = htmlResp.data.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
                        if (match && match[1]) {
                            try {
                                const nextData = JSON.parse(match[1]);
                                const pageProps = nextData?.props?.pageProps;
                                const title = pageProps?.title || pageProps?.hearing?.title || pageProps?.data?.title;
                                
                                if (title && title !== `Høring ${hearing.id}`) {
                                    updateStmt.run(title, hearing.id);
                                    backfilled++;
                                    console.log(`[FORCE FETCH] Backfilled title for hearing ${hearing.id}: ${title.substring(0, 50)}...`);
                                }
                            } catch (parseErr) {
                                // JSON parse failed
                            }
                        }
                    }
                    
                    // Rate limit
                    if (backfilled % 10 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    
                } catch (e) {
                    // Skip this one
                }
            }
            
            if (backfilled > 0) {
                console.log(`[FORCE FETCH] Successfully backfilled ${backfilled} titles`);
            }
        }
        
        // Get final statistics
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN title IS NOT NULL AND title != '' AND title NOT LIKE 'Høring %' THEN 1 END) as with_titles,
                COUNT(CASE WHEN status LIKE '%aktiv%' THEN 1 END) as active,
                COUNT(CASE WHEN status LIKE '%afsluttet%' THEN 1 END) as completed,
                COUNT(CASE WHEN status LIKE '%afventer%' THEN 1 END) as pending
            FROM hearings
        `).get();
        
        console.log('\n[FORCE FETCH] Final database statistics:');
        console.log(`  - Total hearings: ${stats.total}`);
        console.log(`  - With proper titles: ${stats.with_titles}`);
        console.log(`  - Active: ${stats.active}`);
        console.log(`  - Completed: ${stats.completed}`);
        console.log(`  - Pending: ${stats.pending}`);
        
        // Show some recent hearings with titles
        const recent = db.prepare(`
            SELECT id, title, status, deadline 
            FROM hearings 
            WHERE title IS NOT NULL AND title != '' AND title NOT LIKE 'Høring %'
            AND deadline > date('now') 
            ORDER BY deadline ASC 
            LIMIT 5
        `).all();
        
        if (recent.length > 0) {
            console.log('\n[FORCE FETCH] Upcoming hearings with titles:');
            recent.forEach(h => {
                console.log(`  - ${h.id}: ${h.title.substring(0, 60)}... (${h.deadline})`);
            });
        }
        
        // Show newest entries with titles
        const newest = db.prepare(`
            SELECT id, title, status 
            FROM hearings 
            WHERE title IS NOT NULL AND title != '' AND title NOT LIKE 'Høring %'
            ORDER BY id DESC 
            LIMIT 5
        `).all();
        
        if (newest.length > 0) {
            console.log('\n[FORCE FETCH] Newest hearings with titles:');
            newest.forEach(h => {
                console.log(`  - ${h.id}: ${h.title.substring(0, 60)}... (${h.status})`);
            });
        }
        
    } catch (e) {
        console.error('[FORCE FETCH] Error fetching hearings:', e.message);
        console.error(e.stack);
    } finally {
        if (db) {
            db.close();
            console.log('\n[FORCE FETCH] Database closed');
        }
    }
}

// Run the fetch
fetchAndStoreHearings().then(() => {
    console.log('[FORCE FETCH] Script completed successfully!');
    process.exit(0);
}).catch(e => {
    console.error('[FORCE FETCH] Fatal error:', e);
    process.exit(1);
});