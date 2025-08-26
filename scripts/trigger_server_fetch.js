#!/usr/bin/env node
// Trigger server data fetch
// This script triggers the server's own data fetching mechanisms

const axios = require('axios');

async function triggerServerFetch() {
    const baseUrl = process.env.PUBLIC_URL || 'https://blivhort-ai.onrender.com';
    console.log(`[TRIGGER] Using base URL: ${baseUrl}`);
    
    try {
        // First, check server status
        console.log('[TRIGGER] Checking server status...');
        const statusResp = await axios.get(`${baseUrl}/api/db-status`, {
            validateStatus: () => true,
            timeout: 10000
        });
        
        if (statusResp.status === 200) {
            console.log('[TRIGGER] Server status:', statusResp.data);
        }
        
        // Trigger the daily scrape endpoint
        console.log('\n[TRIGGER] Triggering daily scrape...');
        try {
            const scrapeResp = await axios.post(`${baseUrl}/api/run-daily-scrape`, 
                { reason: 'manual_trigger' },
                {
                    validateStatus: () => true,
                    timeout: 300000 // 5 minutes
                }
            );
            
            console.log('[TRIGGER] Daily scrape response:', scrapeResp.status, scrapeResp.data);
            
            // Wait for it to process
            console.log('[TRIGGER] Waiting for processing...');
            await new Promise(resolve => setTimeout(resolve, 30000));
            
        } catch (e) {
            console.error('[TRIGGER] Daily scrape failed:', e.message);
        }
        
        // Try the rebuild index endpoint
        console.log('\n[TRIGGER] Triggering index rebuild...');
        try {
            const rebuildResp = await axios.post(`${baseUrl}/api/rebuild-index`,
                {},
                {
                    validateStatus: () => true,
                    timeout: 120000
                }
            );
            
            console.log('[TRIGGER] Rebuild response:', rebuildResp.status, rebuildResp.data);
            
        } catch (e) {
            console.error('[TRIGGER] Rebuild failed:', e.message);
        }
        
        // Check final status
        console.log('\n[TRIGGER] Checking final status...');
        const finalStatus = await axios.get(`${baseUrl}/api/db-status`, {
            validateStatus: () => true,
            timeout: 10000
        });
        
        if (finalStatus.status === 200) {
            console.log('[TRIGGER] Final status:', finalStatus.data);
            
            if (finalStatus.data.hearingCount > 0) {
                console.log(`\n[TRIGGER] SUCCESS! Database now has ${finalStatus.data.hearingCount} hearings`);
            } else {
                console.log('\n[TRIGGER] WARNING: Still no hearings in database');
            }
        }
        
    } catch (e) {
        console.error('[TRIGGER] Error:', e.message);
    }
}

// Run it
triggerServerFetch().then(() => {
    console.log('\n[TRIGGER] Done!');
    process.exit(0);
}).catch(e => {
    console.error('[TRIGGER] Fatal error:', e);
    process.exit(1);
});