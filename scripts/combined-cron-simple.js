#!/usr/bin/env node

// Simple cron job that uses built-in modules only
const https = require('https');
const http = require('http');

console.log('[COMBINED-CRON] Starting combined cron job (no dependencies version)...');
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
        
        console.log('[COMBINED-CRON] Daily scrape completed');
    } catch (e) {
        console.error('[COMBINED-CRON] Daily scrape failed:', e.message);
        throw e;
    }
}

// Main execution
async function main() {
    try {
        console.log('[COMBINED-CRON] Running daily scrape...');
        await runDailyScrape();
        
        console.log('[COMBINED-CRON] All tasks completed successfully');
        process.exit(0);
    } catch (e) {
        console.error('[COMBINED-CRON] Fatal error:', e);
        process.exit(1);
    }
}

// Run main function
main();