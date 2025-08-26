#!/bin/bash
# Emergency fix for Render database path issue
# Run this directly on Render server via SSH

echo "[EMERGENCY FIX] Starting database path fix..."

# Check current location
echo "[FIX] Current directory: $(pwd)"
echo "[FIX] Checking for data directory..."

# The actual mount path on Render
RENDER_DATA_DIR="/opt/render/project/src/fetcher/data"

# Check if mounted disk exists
if [ -d "$RENDER_DATA_DIR" ]; then
    echo "[FIX] Found mounted disk at: $RENDER_DATA_DIR"
    ls -la "$RENDER_DATA_DIR"
else
    echo "[FIX] ERROR: Mounted disk not found at $RENDER_DATA_DIR"
    echo "[FIX] Creating directory structure..."
    mkdir -p "$RENDER_DATA_DIR"
fi

# Create symlink from expected location to actual location
if [ ! -L "/opt/render/project/src/data" ]; then
    echo "[FIX] Creating symlink from ./data to mounted disk..."
    cd /opt/render/project/src
    ln -sf fetcher/data data
    echo "[FIX] Symlink created"
fi

# Test database access
echo "[FIX] Testing database access..."
cd /opt/render/project/src

# Create a test script to initialize database
cat > test_db_init.js << 'EOF'
const path = require('path');
const fs = require('fs');

console.log('[TEST] Testing database initialization...');
console.log('[TEST] Current directory:', process.cwd());

// Try multiple paths
const paths = [
    './data/app.sqlite',
    '/opt/render/project/src/data/app.sqlite',
    '/opt/render/project/src/fetcher/data/app.sqlite'
];

for (const dbPath of paths) {
    console.log(`[TEST] Checking path: ${dbPath}`);
    const dir = path.dirname(dbPath);
    console.log(`[TEST] Directory exists: ${fs.existsSync(dir)}`);
    if (fs.existsSync(dir)) {
        console.log(`[TEST] Directory contents:`, fs.readdirSync(dir));
    }
}

// Force initialize with correct path
process.env.DB_PATH = '/opt/render/project/src/fetcher/data/app.sqlite';
console.log('[TEST] Set DB_PATH to:', process.env.DB_PATH);

try {
    const { init: initDb, db: sqliteDb } = require('./db/sqlite');
    initDb();
    console.log('[TEST] Database initialized successfully!');
    
    if (sqliteDb) {
        const count = sqliteDb.prepare('SELECT COUNT(*) as count FROM hearings').get();
        console.log('[TEST] Hearings in database:', count.count);
    }
} catch (e) {
    console.error('[TEST] Database init failed:', e);
}
EOF

# Run the test
echo "[FIX] Running database initialization test..."
node test_db_init.js

# Clean up
rm -f test_db_init.js

# Set environment variable permanently
echo "[FIX] Setting DB_PATH environment variable..."
echo "export DB_PATH=/opt/render/project/src/fetcher/data/app.sqlite" >> ~/.bashrc

# Restart the service
echo "[FIX] Emergency fix complete!"
echo "[FIX] You may need to restart the service for changes to take effect."
echo ""
echo "[FIX] To manually restart, run:"
echo "  kill -TERM \$(pgrep -f 'node server.js')"
echo ""
echo "[FIX] The service should auto-restart with correct database path."