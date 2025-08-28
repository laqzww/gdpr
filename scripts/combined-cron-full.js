#!/usr/bin/env node

// Full cron job that includes search index rebuilding
const https = require('https');
const http = require('http');

console.log('[COMBINED-CRON] Starting full combined cron job...');
console.log('[COMBINED-CRON] Current time:', new Date().toISOString());

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://blivhort-ai.onrender.com';

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const req = client.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        data: JSON.parse(data)
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        data: data
                    });
                }
            });
        });
        
        req.on('error', reject);
        
        if (options.body) {
            req.write(options.body);
        }
        
        req.end();
    });
}

async function rebuildSearchIndex() {
    try {
        console.log('[COMBINED-CRON] Rebuilding search index...');
        
        // Call the rebuild-index endpoint which triggers warmHearingIndex
        const resp = await makeRequest(`${PUBLIC_URL}/api/rebuild-index`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log('[COMBINED-CRON] Search index rebuild response:', resp.status, resp.data);
        
        // Wait a bit for the index to be built
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        // Check how many items are in the index now
        const indexResp = await makeRequest(`${PUBLIC_URL}/api/hearing-index`);
        console.log('[COMBINED-CRON] Index status after rebuild:', { 
            success: indexResp.data?.success, 
            count: indexResp.data?.hearings?.length || 0,
            message: 'Index should now be populated'
        });
        
    } catch (e) {
        console.error('[COMBINED-CRON] Search index rebuild failed:', e.message);
        // Don't throw - continue with other tasks
    }
}

async function runDailyScrape() {
    try {
        console.log('[COMBINED-CRON] Starting daily scrape...');
        
        const resp = await makeRequest(`${PUBLIC_URL}/api/run-daily-scrape`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ reason: 'scheduled_daily_combined' })
        });
        
        console.log('[COMBINED-CRON] Daily scrape response:', resp.status, resp.data);
        
        // Wait for it to complete
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        // Check database status
        const statusResp = await makeRequest(`${PUBLIC_URL}/api/db-status`);
        console.log('[COMBINED-CRON] Database status:', statusResp.data);
        
        // If database is not initialized, try to reinitialize it
        if (statusResp.data && statusResp.data.error === 'Database not initialized') {
            console.log('[COMBINED-CRON] Database not initialized, attempting to reinitialize...');
            const reinitResp = await makeRequest(`${PUBLIC_URL}/api/db-reinit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            console.log('[COMBINED-CRON] Database reinit response:', reinitResp.status, reinitResp.data);
            
            // Check status again
            await new Promise(resolve => setTimeout(resolve, 5000));
            const newStatusResp = await makeRequest(`${PUBLIC_URL}/api/db-status`);
            console.log('[COMBINED-CRON] Database status after reinit:', newStatusResp.data);
        }
        
        console.log('[COMBINED-CRON] Daily scrape completed');
    } catch (e) {
        console.error('[COMBINED-CRON] Daily scrape failed:', e.message);
        throw e;
    }
}

async function refreshPendingHearings() {
    try {
        console.log('[COMBINED-CRON] Refreshing pending hearings...');
        
        // Call the refresh-open endpoint which handles pending hearings
        const resp = await makeRequest(`${PUBLIC_URL}/api/refresh/open`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ reason: 'cron_refresh' })
        });
        
        console.log('[COMBINED-CRON] Pending hearings refresh response:', resp.status, resp.data);
        
    } catch (e) {
        console.error('[COMBINED-CRON] Pending hearings refresh failed:', e.message);
        // Don't throw - continue with other tasks
    }
}

// Main execution
async function main() {
    try {
        // Step 1: Rebuild search index (this fetches all hearings with proper titles)
        console.log('[COMBINED-CRON] Step 1/3: Rebuilding search index...');
        await rebuildSearchIndex();
        
        // Step 2: Run daily scrape
        console.log('[COMBINED-CRON] Step 2/3: Running daily scrape...');
        await runDailyScrape();
        
        // Step 3: Refresh pending hearings
        console.log('[COMBINED-CRON] Step 3/3: Refreshing pending hearings...');
        await refreshPendingHearings();
        
        console.log('[COMBINED-CRON] All tasks completed successfully');
        process.exit(0);
    } catch (e) {
        console.error('[COMBINED-CRON] Fatal error:', e);
        process.exit(1);
    }
}

// Run main function
main();