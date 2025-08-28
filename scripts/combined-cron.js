#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Initialize database
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
                    sqliteDb.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?,?,?,?,?,?)').run(
                        h.id, h.title, h.startDate, h.deadline, h.status, Date.now()
                    );
                } catch (e) {
                    console.error(`[COMBINED-CRON] Failed to upsert hearing ${h.id}:`, e.message);
                }
            }
        }
        
        // Refresh pending hearings
        const pendingHearings = sqliteDb.prepare(`
            SELECT id FROM hearings 
            WHERE archived IS NOT 1 
            AND LOWER(status) LIKE '%afventer konklusion%'
            ORDER BY updated_at ASC
            LIMIT 20
        `).all();
        
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