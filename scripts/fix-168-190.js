#!/usr/bin/env node

const sqlite = require('../db/sqlite');

// Initialize database
sqlite.init();

console.log('Fixing hearings 168 and 190...');

// Manually update with correct titles
const updates = [
    { id: 168, title: 'Tillæg 6 til lp Grønttorvsområdet - forslag til lokalplan' },
    { id: 190, title: 'Klimastrategi og Klimahandleplan' }
];

for (const update of updates) {
    try {
        // First delete any existing record
        sqlite.db.prepare('DELETE FROM hearings WHERE id = ?').run(update.id);
        console.log(`Deleted existing record for hearing ${update.id}`);
        
        // Insert fresh record with correct title
        sqlite.upsertHearing({
            id: update.id,
            title: update.title,
            status: 'Afventer konklusion',
            startDate: null,
            deadline: null
        });
        console.log(`Inserted hearing ${update.id} with title: ${update.title}`);
        
        // Verify it was saved
        const check = sqlite.db.prepare('SELECT id, title, status FROM hearings WHERE id = ?').get(update.id);
        console.log(`Verification for ${update.id}:`, check);
        
    } catch (error) {
        console.error(`Error updating hearing ${update.id}:`, error);
    }
}

console.log('\nDone!');
process.exit(0);