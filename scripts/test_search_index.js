#!/usr/bin/env node

// Test script to verify hearing search index improvements

const sqlite = require('../db/sqlite');

async function testSearchIndex() {
    console.log('=== Testing Hearing Search Index ===\n');
    
    // Initialize database
    sqlite.init();
    
    // Get all hearings from database
    const allHearings = sqlite.db.prepare(`
        SELECT id, title, status 
        FROM hearings 
        WHERE archived IS NOT 1
        ORDER BY id DESC
        LIMIT 20
    `).all();
    
    console.log('Recent hearings in database:');
    for (const h of allHearings) {
        const statusInfo = h.status ? ` [${h.status}]` : '';
        console.log(`  ${h.id}: ${h.title || 'NO TITLE'}${statusInfo}`);
    }
    
    console.log('\n---\n');
    
    // Get hearing index (filtered)
    const hearingIndex = sqlite.getHearingIndex();
    
    console.log(`Hearing index contains ${hearingIndex.length} entries (excluding "Afventer konklusion")\n`);
    
    // Show some examples
    console.log('Sample entries from hearing index:');
    for (const h of hearingIndex.slice(0, 10)) {
        const statusInfo = h.status ? ` [${h.status}]` : '';
        console.log(`  ${h.id}: ${h.title || 'NO TITLE'}${statusInfo}`);
    }
    
    // Count hearings with "Afventer konklusion" status
    const awaitingCount = sqlite.db.prepare(`
        SELECT COUNT(*) as count 
        FROM hearings 
        WHERE archived IS NOT 1 
        AND LOWER(status) LIKE '%afventer konklusion%'
    `).get().count;
    
    console.log(`\n---\n`);
    console.log(`Statistics:`);
    console.log(`  Total hearings (not archived): ${allHearings.length}`);
    console.log(`  Hearings in search index: ${hearingIndex.length}`);
    console.log(`  Hearings with "Afventer konklusion": ${awaitingCount}`);
    console.log(`  Expected index size: ${allHearings.length - awaitingCount}`);
    
    // Check for missing titles
    const missingTitles = hearingIndex.filter(h => !h.title || h.title.match(/^Høring \d+$/));
    if (missingTitles.length > 0) {
        console.log(`\nHearings with missing/placeholder titles: ${missingTitles.length}`);
        for (const h of missingTitles.slice(0, 5)) {
            console.log(`  ${h.id}: "${h.title}"`);
        }
    }
    
    console.log('\n=== Test Complete ===');
}

testSearchIndex().catch(console.error);