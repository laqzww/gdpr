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
        const pageSize = 100; // Increased page size for efficiency
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
                
                const items = Array.isArray(response.data?.data) ? response.data.data : [];
                if (items.length === 0) {
                    console.log(`[FORCE FETCH] No more items at page ${page}`);
                    break;
                }
                
                // Store each hearing in a transaction for better performance
                const insertMany = db.transaction((hearings) => {
                    for (const hearing of hearings) {
                        try {
                            stmt.run(
                                hearing.id,
                                hearing.title || 'Untitled',
                                hearing.startDate,
                                hearing.deadline,
                                hearing.status || 'Unknown',
                                Date.now()
                            );
                            totalStored++;
                        } catch (e) {
                            console.error(`[FORCE FETCH] Failed to store hearing ${hearing.id}:`, e.message);
                        }
                    }
                });
                
                insertMany(items);
                consecutiveErrors = 0; // Reset error counter on success
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
        
        console.log(`[FORCE FETCH] Completed! Stored ${totalStored} hearings from ${page - 1} pages`);
        
        // Get final statistics
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status LIKE '%aktiv%' THEN 1 END) as active,
                COUNT(CASE WHEN status LIKE '%afsluttet%' THEN 1 END) as completed,
                COUNT(CASE WHEN status LIKE '%afventer%' THEN 1 END) as pending
            FROM hearings
        `).get();
        
        console.log('[FORCE FETCH] Database statistics:');
        console.log(`  - Total hearings: ${stats.total}`);
        console.log(`  - Active: ${stats.active}`);
        console.log(`  - Completed: ${stats.completed}`);
        console.log(`  - Pending: ${stats.pending}`);
        
        // Show some recent hearings
        const recent = db.prepare(`
            SELECT id, title, status, deadline 
            FROM hearings 
            WHERE deadline > date('now') 
            ORDER BY deadline ASC 
            LIMIT 5
        `).all();
        
        if (recent.length > 0) {
            console.log('\n[FORCE FETCH] Upcoming hearings:');
            recent.forEach(h => {
                console.log(`  - ${h.id}: ${h.title.substring(0, 50)}... (${h.deadline})`);
            });
        }
        
        // Show newest entries
        const newest = db.prepare(`
            SELECT id, title, status 
            FROM hearings 
            ORDER BY id DESC 
            LIMIT 5
        `).all();
        
        console.log('\n[FORCE FETCH] Newest hearings:');
        newest.forEach(h => {
            console.log(`  - ${h.id}: ${h.title.substring(0, 50)}... (${h.status})`);
        });
        
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