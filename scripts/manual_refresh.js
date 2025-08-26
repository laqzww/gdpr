#!/usr/bin/env node
const axios = require('axios');
const { init: initDb, db: sqliteDb } = require('../db/sqlite');

console.log('[MANUAL] Starting manual hearing refresh...');

// Initialize database
try {
    initDb();
    console.log('[MANUAL] Database initialized');
} catch (e) {
    console.error('[MANUAL] Database init failed:', e);
    process.exit(1);
}

async function manualRefresh() {
    try {
        // First, trigger the daily scrape
        console.log('[MANUAL] Triggering daily scrape...');
        const base = process.env.PUBLIC_URL || 'https://blivhort-ai.onrender.com';
        
        const scrapeResp = await axios.post(`${base}/api/run-daily-scrape`, 
            { reason: 'manual_ssh' }, 
            { validateStatus: () => true, timeout: 120000 }
        );
        console.log('[MANUAL] Daily scrape response:', scrapeResp.status, scrapeResp.data);
        
        // Wait for scrape to start
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check current database status
        const statusResp = await axios.get(`${base}/api/db-status`, { validateStatus: () => true });
        console.log('[MANUAL] Current database status:', JSON.stringify(statusResp.data, null, 2));
        
        // Force some direct database operations
        if (sqliteDb && sqliteDb.prepare) {
            console.log('[MANUAL] Checking database directly...');
            const count = sqliteDb.prepare('SELECT COUNT(*) as count FROM hearings').get();
            console.log('[MANUAL] Hearings in database:', count.count);
            
            // Try to fetch and insert ALL hearings
            console.log('[MANUAL] Fetching ALL hearings from API...');
            let page = 1;
            let totalFetched = 0;
            const pageSize = 100;
            const stmt = sqliteDb.prepare(`
                INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) 
                VALUES (?,?,?,?,?,?)
            `);
            
            while (page <= 50) { // Safety limit for manual run
                try {
                    const url = `https://blivhoert.kk.dk/api/hearing?PageIndex=${page}&PageSize=${pageSize}`;
                    const apiResp = await axios.get(url, { validateStatus: () => true });
                    
                    if (apiResp.status !== 200 || !apiResp.data) {
                        console.log(`[MANUAL] No more pages at page ${page}`);
                        break;
                    }
                    
                    const data = apiResp.data;
                    const items = data?.data || [];
                    const included = data?.included || [];
                    
                    if (items.length === 0) {
                        console.log(`[MANUAL] No more items at page ${page}`);
                        break;
                    }
                    
                    // Build maps for lookups
                    const titleByContentId = new Map();
                    const statusById = new Map();
                    
                    for (const inc of included) {
                        if (inc?.type === 'content') {
                            const fieldId = inc?.relationships?.field?.data?.id;
                            if (String(fieldId) === '1' && inc?.attributes?.textContent) {
                                titleByContentId.set(String(inc.id), String(inc.attributes.textContent).trim());
                            }
                        }
                        if (inc?.type === 'hearingStatus' && inc?.attributes?.name) {
                            statusById.set(String(inc.id), inc.attributes.name);
                        }
                    }
                    
                    console.log(`[MANUAL] Page ${page}: Found ${items.length} hearings`);
                    
                    let pageStored = 0;
                    for (const item of items) {
                        if (item.type !== 'hearing') continue;
                        
                        const hId = Number(item.id);
                        const attrs = item.attributes || {};
                        
                        // Extract title
                        let title = '';
                        const contentRels = (item.relationships?.contents?.data) || [];
                        for (const cref of contentRels) {
                            const cid = cref?.id && String(cref.id);
                            if (cid && titleByContentId.has(cid)) {
                                title = titleByContentId.get(cid);
                                break;
                            }
                        }
                        
                        if (!title) {
                            title = attrs.esdhTitle || `Høring ${hId}`;
                        }
                        
                        // Extract status
                        const statusRelId = item.relationships?.hearingStatus?.data?.id;
                        const status = statusRelId && statusById.has(String(statusRelId)) 
                            ? statusById.get(String(statusRelId))
                            : 'Unknown';
                        
                        try {
                            stmt.run(hId, title, attrs.startDate, attrs.deadline, status, Date.now());
                            totalFetched++;
                            pageStored++;
                        } catch (e) {
                            console.error(`[MANUAL] Failed to insert hearing ${hId}:`, e.message);
                        }
                    }
                    
                    console.log(`[MANUAL] Page ${page}: Stored ${pageStored} hearings`);
                    
                    page++;
                    if (page % 10 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit
                    }
                } catch (e) {
                    console.error(`[MANUAL] Error on page ${page}:`, e.message);
                    break;
                }
            }
            
            console.log(`[MANUAL] Fetched and stored ${totalFetched} hearings total`);
            
            // Check count again
            const newCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM hearings').get();
            console.log('[MANUAL] Hearings in database after insert:', newCount.count);
            
            // Trigger prefetch for a specific hearing
            if (hearings.length > 0) {
                const testId = hearings[0].id;
                console.log(`[MANUAL] Triggering prefetch for hearing ${testId}...`);
                const prefetchResp = await axios.post(`${base}/api/prefetch/${testId}?apiOnly=1`, 
                    { reason: 'manual_test' }, 
                    { validateStatus: () => true, timeout: 60000 }
                );
                console.log(`[MANUAL] Prefetch response:`, prefetchResp.status, prefetchResp.data);
            }
        }
        
        // Final status check
        await new Promise(resolve => setTimeout(resolve, 10000));
        const finalStatus = await axios.get(`${base}/api/db-status`, { validateStatus: () => true });
        console.log('[MANUAL] Final database status:', JSON.stringify(finalStatus.data, null, 2));
        
    } catch (e) {
        console.error('[MANUAL] Error:', e.message);
        if (e.response) {
            console.error('[MANUAL] Response:', e.response.status, e.response.data);
        }
    }
}

manualRefresh().then(() => {
    console.log('[MANUAL] Refresh completed');
    process.exit(0);
}).catch(e => {
    console.error('[MANUAL] Fatal error:', e);
    process.exit(1);
});