#!/usr/bin/env node
// Complete data fetch - fetches ALL hearings, responses, and materials
// Run this on Render server to populate the database completely

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');

console.log('[COMPLETE FETCH] Starting complete data fetch...');
console.log('[COMPLETE FETCH] This will fetch hearings, responses, and materials');

// Setup database path
const correctDbPath = '/opt/render/project/src/fetcher/data/app.sqlite';
process.env.DB_PATH = correctDbPath;

// Ensure directory exists
const dbDir = path.dirname(correctDbPath);
if (!fs.existsSync(dbDir)) {
    console.log('[COMPLETE FETCH] Creating directory:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
}

// Open database
let db;
try {
    db = new Database(correctDbPath);
    console.log('[COMPLETE FETCH] Database opened successfully');
} catch (e) {
    console.error('[COMPLETE FETCH] Failed to open database:', e.message);
    process.exit(1);
}

// Initialize all tables
function initTables() {
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
          submitted_at TEXT
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
          idx INTEGER,
          type TEXT,
          title TEXT,
          url TEXT,
          content TEXT,
          PRIMARY KEY (hearing_id, idx)
        );
        
        CREATE INDEX IF NOT EXISTS idx_hearings_status ON hearings(status);
        CREATE INDEX IF NOT EXISTS idx_hearings_archived ON hearings(archived);
        CREATE INDEX IF NOT EXISTS idx_responses_hearing ON responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_hearing ON attachments(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_materials_hearing ON materials(hearing_id);
    `);
    console.log('[COMPLETE FETCH] All tables initialized');
}

// Step 1: Fetch all hearings
async function fetchAllHearings() {
    console.log('\n=== STEP 1: FETCHING ALL HEARINGS ===');
    
    const baseApi = 'https://blivhoert.kk.dk/api/hearing';
    let page = 1;
    const pageSize = 100;
    let totalFetched = 0;
    const allHearings = [];
    
    const stmt = db.prepare(`
        INSERT INTO hearings(id, title, start_date, deadline, status, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            start_date=excluded.start_date,
            deadline=excluded.deadline,
            status=excluded.status,
            updated_at=excluded.updated_at
    `);
    
    while (true) {
        try {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            console.log(`[HEARINGS] Fetching page ${page}...`);
            
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                },
                timeout: 30000
            });
            
            if (response.status !== 200) break;
            
            const data = response.data;
            const items = data?.data || [];
            const included = data?.included || [];
            
            if (items.length === 0) break;
            
            // Build status map
            const statusById = new Map();
            for (const inc of included) {
                if (inc?.type === 'hearingStatus') {
                    statusById.set(String(inc.id), inc.attributes?.name || 'Unknown');
                }
            }
            
            // Process hearings
            db.transaction(() => {
                for (const item of items) {
                    if (item.type !== 'hearing') continue;
                    
                    const id = Number(item.id);
                    const attrs = item.attributes || {};
                    const statusId = item.relationships?.hearingStatus?.data?.id;
                    const status = statusById.get(String(statusId)) || 'Unknown';
                    
                    stmt.run(
                        id,
                        attrs.esdhTitle || `Høring ${id}`,
                        attrs.startDate,
                        attrs.deadline,
                        status,
                        Date.now()
                    );
                    
                    allHearings.push({ id, status });
                    totalFetched++;
                }
            })();
            
            console.log(`[HEARINGS] Page ${page}: Stored ${items.length} hearings`);
            
            // Check pagination
            const totalPages = data?.meta?.Pagination?.totalPages;
            if (totalPages && page >= totalPages) break;
            
            page++;
            if (page > 50) break; // Safety limit
            
        } catch (e) {
            console.error(`[HEARINGS] Error on page ${page}:`, e.message);
            break;
        }
    }
    
    console.log(`[HEARINGS] Total hearings fetched: ${totalFetched}`);
    return allHearings;
}

// Step 2: Fetch responses and materials for each hearing
async function fetchHearingDetails(hearingId, status) {
    try {
        // Try server endpoints first
        const baseUrl = 'https://blivhort-ai.onrender.com';
        
        // Fetch responses
        let responses = [];
        try {
            const respResp = await axios.get(`${baseUrl}/api/hearing/${hearingId}/responses`, {
                timeout: 30000,
                validateStatus: () => true
            });
            
            if (respResp.status === 200 && respResp.data?.success) {
                responses = respResp.data.responses || [];
            }
        } catch (e) {
            console.log(`[DETAILS] Failed to fetch responses for ${hearingId}:`, e.message);
        }
        
        // Fetch materials
        let materials = [];
        try {
            const matResp = await axios.get(`${baseUrl}/api/hearing/${hearingId}/materials`, {
                timeout: 30000,
                validateStatus: () => true
            });
            
            if (matResp.status === 200 && matResp.data?.success) {
                materials = matResp.data.materials || [];
            }
        } catch (e) {
            console.log(`[DETAILS] Failed to fetch materials for ${hearingId}:`, e.message);
        }
        
        // Store in database
        if (responses.length > 0) {
            const tx = db.transaction(() => {
                // Clear existing
                db.prepare('DELETE FROM raw_responses WHERE hearing_id = ?').run(hearingId);
                db.prepare('DELETE FROM raw_attachments WHERE hearing_id = ?').run(hearingId);
                
                // Insert new
                const respStmt = db.prepare(`
                    INSERT INTO raw_responses(hearing_id, response_id, text, author, organization, on_behalf_of, submitted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                
                const attStmt = db.prepare(`
                    INSERT INTO raw_attachments(hearing_id, response_id, idx, filename, url)
                    VALUES (?, ?, ?, ?, ?)
                `);
                
                for (const r of responses) {
                    respStmt.run(
                        hearingId,
                        r.id || r.responseNumber,
                        r.text || '',
                        r.author || null,
                        r.organization || null,
                        r.onBehalfOf || null,
                        r.submittedAt || null
                    );
                    
                    // Store attachments
                    if (r.attachments) {
                        r.attachments.forEach((a, idx) => {
                            attStmt.run(hearingId, r.id || r.responseNumber, idx, a.filename || 'Dokument', a.url || null);
                        });
                    }
                }
            });
            tx();
        }
        
        if (materials.length > 0) {
            const tx = db.transaction(() => {
                db.prepare('DELETE FROM raw_materials WHERE hearing_id = ?').run(hearingId);
                
                const matStmt = db.prepare(`
                    INSERT INTO raw_materials(hearing_id, idx, type, title, url, content)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                
                materials.forEach((m, idx) => {
                    matStmt.run(
                        hearingId,
                        idx,
                        m.type || 'unknown',
                        m.title || null,
                        m.url || null,
                        m.content || null
                    );
                });
            });
            tx();
        }
        
        // Update hearing with counts
        db.prepare(`
            UPDATE hearings 
            SET total_responses = ?, total_materials = ?, last_success_at = ?
            WHERE id = ?
        `).run(responses.length, materials.length, Date.now(), hearingId);
        
        return { responses: responses.length, materials: materials.length };
        
    } catch (e) {
        console.error(`[DETAILS] Error fetching details for hearing ${hearingId}:`, e.message);
        return { responses: 0, materials: 0 };
    }
}

// Main execution
async function main() {
    try {
        // Initialize tables
        initTables();
        
        // Step 1: Fetch all hearings
        const hearings = await fetchAllHearings();
        
        // Step 2: Fetch details for active/pending hearings
        console.log('\n=== STEP 2: FETCHING RESPONSES AND MATERIALS ===');
        
        // Filter hearings to fetch details for
        const targetHearings = hearings.filter(h => {
            const s = (h.status || '').toLowerCase();
            return s.includes('aktiv') || s.includes('afventer') || s.includes('høring');
        }).slice(0, 50); // Limit to 50 for now
        
        console.log(`[DETAILS] Will fetch details for ${targetHearings.length} active/pending hearings`);
        
        let totalResponses = 0;
        let totalMaterials = 0;
        let successCount = 0;
        
        for (let i = 0; i < targetHearings.length; i++) {
            const h = targetHearings[i];
            console.log(`[DETAILS] ${i+1}/${targetHearings.length}: Fetching hearing ${h.id}...`);
            
            const result = await fetchHearingDetails(h.id, h.status);
            if (result.responses > 0 || result.materials > 0) {
                totalResponses += result.responses;
                totalMaterials += result.materials;
                successCount++;
                console.log(`[DETAILS] Hearing ${h.id}: ${result.responses} responses, ${result.materials} materials`);
            }
            
            // Rate limit
            if (i % 10 === 9) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log(`\n[DETAILS] Fetched details for ${successCount} hearings`);
        console.log(`[DETAILS] Total responses: ${totalResponses}`);
        console.log(`[DETAILS] Total materials: ${totalMaterials}`);
        
        // Final statistics
        console.log('\n=== FINAL DATABASE STATISTICS ===');
        
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total_hearings,
                COUNT(CASE WHEN total_responses > 0 THEN 1 END) as hearings_with_responses,
                COUNT(CASE WHEN total_materials > 0 THEN 1 END) as hearings_with_materials,
                SUM(total_responses) as total_responses,
                SUM(total_materials) as total_materials
            FROM hearings
        `).get();
        
        console.log('Database contents:');
        console.log(`  - Total hearings: ${stats.total_hearings}`);
        console.log(`  - Hearings with responses: ${stats.hearings_with_responses}`);
        console.log(`  - Hearings with materials: ${stats.hearings_with_materials}`);
        console.log(`  - Total responses: ${stats.total_responses || 0}`);
        console.log(`  - Total materials: ${stats.total_materials || 0}`);
        
        // Show sample data
        const samples = db.prepare(`
            SELECT id, title, status, total_responses, total_materials
            FROM hearings
            WHERE total_responses > 0 OR total_materials > 0
            ORDER BY total_responses DESC
            LIMIT 5
        `).all();
        
        if (samples.length > 0) {
            console.log('\nTop hearings with data:');
            samples.forEach(h => {
                console.log(`  - ${h.id}: ${h.title?.substring(0, 40)}... (${h.total_responses} responses, ${h.total_materials} materials)`);
            });
        }
        
        // Mark as complete
        const completeStmt = db.prepare(`
            UPDATE hearings 
            SET complete = 1, signature = ?
            WHERE id = ? AND total_responses > 0
        `);
        
        const signature = `complete_fetch_${Date.now()}`;
        let markedComplete = 0;
        
        db.transaction(() => {
            for (const h of targetHearings) {
                const result = completeStmt.run(signature, h.id);
                if (result.changes > 0) markedComplete++;
            }
        })();
        
        console.log(`\n[COMPLETE FETCH] Marked ${markedComplete} hearings as complete`);
        console.log('[COMPLETE FETCH] Data fetch completed successfully!');
        
    } catch (e) {
        console.error('[COMPLETE FETCH] Fatal error:', e.message);
        console.error(e.stack);
    } finally {
        if (db) {
            db.close();
            console.log('[COMPLETE FETCH] Database closed');
        }
    }
}

// Run the complete fetch
main().catch(e => {
    console.error('[COMPLETE FETCH] Unhandled error:', e);
    process.exit(1);
});