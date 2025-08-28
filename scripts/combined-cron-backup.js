#!/usr/bin/env node

// Debug module paths on Render
console.log('[COMBINED-CRON] Debug info:');
console.log('- __dirname:', __dirname);
console.log('- process.cwd():', process.cwd());
console.log('- NODE_PATH:', process.env.NODE_PATH);

// Add multiple possible node_modules paths for Render compatibility
const Module = require('module');
const path = require('path');
const fs = require('fs');

// List of possible node_modules locations on Render
const possibleNodeModulePaths = [
    path.join(__dirname, '../node_modules'),                    // /opt/render/project/src/node_modules
    path.join(__dirname, '../../node_modules'),                 // /opt/render/project/node_modules
    path.join(__dirname, '../../../node_modules'),              // /opt/render/node_modules
    '/opt/render/project/node_modules',                         // Absolute path
    '/opt/render/project/src/node_modules',                     // Alternative absolute path
    '/opt/render/node_modules',                                 // Parent directory on Render
    path.join(process.cwd(), 'node_modules'),                   // Current working directory
    path.join(process.cwd(), '../node_modules'),                // Parent of CWD
    path.join(process.cwd(), '../../node_modules')              // Grandparent of CWD
];

// Check which paths exist
console.log('[COMBINED-CRON] Checking for node_modules in:');
possibleNodeModulePaths.forEach(p => {
    const exists = fs.existsSync(p);
    console.log(`- ${p}: ${exists ? 'EXISTS' : 'not found'}`);
    if (exists && fs.existsSync(path.join(p, 'axios'))) {
        console.log(`  └─ axios found in ${p}`);
    }
});

// Override module resolution to check multiple paths
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
    try {
        return originalResolveFilename.call(this, request, parent, isMain);
    } catch (e) {
        // Try each possible node_modules path
        for (const nodeModulesPath of possibleNodeModulePaths) {
            try {
                const modulePath = path.join(nodeModulesPath, request);
                if (fs.existsSync(modulePath) || fs.existsSync(modulePath + '.js')) {
                    return originalResolveFilename.call(this, modulePath, parent, isMain);
                }
            } catch (e2) {
                // Continue to next path
            }
        }
        throw e; // Throw original error if nothing worked
    }
};

const axios = require('axios');

// Initialize database - running from /opt/render/project/src with NODE_PATH set
const sqlite = require('../db/sqlite');

console.log('[COMBINED-CRON] Starting combined cron job...');
console.log('[COMBINED-CRON] Current time:', new Date().toISOString());

// Initialize database
try {
    sqlite.init();
    console.log('[COMBINED-CRON] Database initialized');
} catch (e) {
    console.error('[COMBINED-CRON] Database init failed:', e);
    process.exit(1);
}

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://blivhort-ai.onrender.com';

// Always run both tasks since we only run once daily
function shouldRunDailyScrape() {
    return true; // Always run daily scrape since this job only runs once per day
}

// Hearing refresh function (runs every time)
async function refreshHearings() {
    try {
        console.log('[COMBINED-CRON] Starting hearing refresh...');
        
        // First warm the index
        const baseApi = 'https://blivhoert.kk.dk/api/hearing';
        let page = 1;
        const pageSize = 50;
        const collected = [];
        
        for (;;) {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            const r = await axios.get(url, { validateStatus: () => true });
            if (r.status !== 200 || !r.data) break;
            const items = Array.isArray(r.data?.data) ? r.data.data : [];
            if (items.length === 0) break;
            collected.push(...items);
            page++;
        }
        
        console.log(`[COMBINED-CRON] Found ${collected.length} hearings in total`);
        
        // Update database
        if (sqlite.db && sqlite.db.prepare) {
            for (const h of collected) {
                try {
                    sqlite.db.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?,?,?,?,?,?)').run(
                        h.id, h.title, h.startDate, h.deadline, h.status, Date.now()
                    );
                } catch (e) {
                    console.error(`[COMBINED-CRON] Failed to upsert hearing ${h.id}:`, e.message);
                }
            }
        }
        
        // Refresh pending hearings
        let pendingHearings = [];
        if (sqlite.db && sqlite.db.prepare) {
            pendingHearings = sqlite.db.prepare(`
                SELECT id FROM hearings 
                WHERE archived IS NOT 1 
                AND LOWER(status) LIKE '%afventer konklusion%'
                ORDER BY updated_at ASC
                LIMIT 20
            `).all();
        }
        
        console.log(`[COMBINED-CRON] Found ${pendingHearings.length} pending hearings to refresh`);
        
        for (const hearing of pendingHearings) {
            try {
                const resp = await axios.post(`${PUBLIC_URL}/api/prefetch/${hearing.id}?apiOnly=1`, 
                    { reason: 'cron_refresh' }, 
                    { validateStatus: () => true, timeout: 60000 }
                );
                console.log(`[COMBINED-CRON] Refreshed hearing ${hearing.id}: ${resp.status}`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limit
            } catch (e) {
                console.error(`[COMBINED-CRON] Failed to refresh hearing ${hearing.id}:`, e.message);
            }
        }
        
        console.log('[COMBINED-CRON] Hearing refresh completed');
    } catch (e) {
        console.error('[COMBINED-CRON] Hearing refresh failed:', e);
        throw e;
    }
}

// Daily scrape function (runs only at 3 AM)
async function runDailyScrape() {
    try {
        console.log('[COMBINED-CRON] Starting daily scrape...');
        
        const resp = await axios.post(`${PUBLIC_URL}/api/run-daily-scrape`, 
            { reason: 'scheduled_daily_combined' }, 
            { validateStatus: () => true, timeout: 300000 }
        );
        console.log('[COMBINED-CRON] Daily scrape response:', resp.status, resp.data);
        
        // Wait for it to complete
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        // Check database status
        const statusResp = await axios.get(`${PUBLIC_URL}/api/db-status`, { validateStatus: () => true });
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
        // Always run hearing refresh
        await refreshHearings();
        
        // Always run daily scrape since we only run once per day
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