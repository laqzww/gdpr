#!/usr/bin/env node

// Simple wrapper that changes to the project root before running the actual cron job
const { execSync } = require('child_process');
const path = require('path');

console.log('[CRON-WRAPPER] Starting from:', process.cwd());

// Change to project root where node_modules exists
try {
    // Try to find the project root by looking for package.json
    const possibleRoots = [
        '/opt/render/project',
        '/opt/render/project/src',
        path.join(__dirname, '..'),
        path.join(__dirname, '../..'),
        process.cwd()
    ];
    
    let projectRoot = null;
    const fs = require('fs');
    
    for (const root of possibleRoots) {
        if (fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'node_modules'))) {
            projectRoot = root;
            console.log('[CRON-WRAPPER] Found project root at:', root);
            break;
        }
    }
    
    if (!projectRoot) {
        throw new Error('Could not find project root with node_modules');
    }
    
    // Change to project root and run the actual cron job
    process.chdir(projectRoot);
    console.log('[CRON-WRAPPER] Changed directory to:', process.cwd());
    
    // Now require the actual cron job - paths should work from here
    require('./src/scripts/combined-cron.js');
    
} catch (error) {
    console.error('[CRON-WRAPPER] Error:', error);
    process.exit(1);
}