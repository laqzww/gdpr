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
        console.log('[FORCE FETCH] Fetching hearings from API...');
        const baseApi = 'https://blivhoert.kk.dk/api/hearing';
        let page = 1;
        const pageSize = 50;
        let totalStored = 0;
        
        for (;;) {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            console.log(`[FORCE FETCH] Fetching page ${page}...`);
            
            const response = await axios.get(url, { 
                validateStatus: () => true,
                timeout: 30000 
            });
            
            if (response.status !== 200 || !response.data) {
                console.log(`[FORCE FETCH] No more pages (status: ${response.status})`);
                break;
            }
            
            const items = Array.isArray(response.data?.data) ? response.data.data : [];
            if (items.length === 0) {
                console.log('[FORCE FETCH] No more items');
                break;
            }
            
            console.log(`[FORCE FETCH] Got ${items.length} hearings`);
            
            // Store each hearing
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            for (const hearing of items) {
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
            
            page++;
            
            // Limit to prevent too long execution
            if (page > 10) {
                console.log('[FORCE FETCH] Reached page limit');
                break;
            }
        }
        
        console.log(`[FORCE FETCH] Stored ${totalStored} hearings`);
        
        // Get count from database
        const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
        console.log(`[FORCE FETCH] Total hearings in database: ${count.count}`);
        
        // Show some sample data
        const samples = db.prepare('SELECT id, title, status FROM hearings LIMIT 5').all();
        console.log('[FORCE FETCH] Sample hearings:');
        samples.forEach(h => {
            console.log(`  - ${h.id}: ${h.title} (${h.status})`);
        });
        
    } catch (e) {
        console.error('[FORCE FETCH] Error fetching hearings:', e.message);
    } finally {
        if (db) {
            db.close();
            console.log('[FORCE FETCH] Database closed');
        }
    }
}

// Run the fetch
fetchAndStoreHearings().then(() => {
    console.log('[FORCE FETCH] Complete!');
    process.exit(0);
}).catch(e => {
    console.error('[FORCE FETCH] Fatal error:', e);
    process.exit(1);
});