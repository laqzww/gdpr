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
                    
                    const hearings = apiResp.data?.data || [];
                    if (hearings.length === 0) {
                        console.log(`[MANUAL] No more hearings at page ${page}`);
                        break;
                    }
                    
                    console.log(`[MANUAL] Page ${page}: Found ${hearings.length} hearings`);
                    
                    for (const h of hearings) {
                        try {
                            stmt.run(h.id, h.title, h.startDate, h.deadline, h.status, Date.now());
                            totalFetched++;
                        } catch (e) {
                            console.error(`[MANUAL] Failed to insert hearing ${h.id}:`, e.message);
                        }
                    }
                    
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