// Temporary API endpoint for database initialization
// Add this to server.js temporarily

app.get('/api/emergency-init', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const { execSync } = require('child_process');
        
        // Security check - only allow from localhost or with secret
        const secret = req.query.secret;
        if (secret !== 'emergency2024' && !req.hostname.includes('localhost')) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        const result = {
            timestamp: new Date().toISOString(),
            environment: {
                RENDER: process.env.RENDER,
                cwd: process.cwd(),
                dbPath: process.env.DB_PATH
            },
            steps: []
        };
        
        // Step 1: Create symlink
        try {
            if (!fs.existsSync('/opt/render/project/src/data')) {
                execSync('ln -s fetcher/data /opt/render/project/src/data');
                result.steps.push({ step: 'symlink', status: 'created' });
            } else {
                result.steps.push({ step: 'symlink', status: 'exists' });
            }
        } catch (e) {
            result.steps.push({ step: 'symlink', status: 'error', error: e.message });
        }
        
        // Step 2: Initialize database directly
        try {
            const Database = require('better-sqlite3');
            const dbPath = '/opt/render/project/src/fetcher/data/app.sqlite';
            
            // Ensure directory exists
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
            
            const db = new Database(dbPath);
            
            // Create tables
            db.exec(`
                CREATE TABLE IF NOT EXISTS hearings(
                  id INTEGER PRIMARY KEY,
                  title TEXT,
                  start_date TEXT,
                  deadline TEXT,
                  status TEXT,
                  updated_at INTEGER,
                  complete INTEGER,
                  signature TEXT,
                  total_responses INTEGER,
                  archived INTEGER DEFAULT 0
                );
            `);
            
            result.steps.push({ step: 'database_init', status: 'success', path: dbPath });
            
            // Step 3: Fetch and store data
            const axios = require('axios');
            const response = await axios.get('https://blivhoert.kk.dk/api/hearing?PageIndex=1&PageSize=10');
            const hearings = response.data?.data || [];
            
            const stmt = db.prepare('INSERT OR REPLACE INTO hearings(id, title, start_date, deadline, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
            
            for (const h of hearings) {
                stmt.run(h.id, h.title, h.startDate, h.deadline, h.status, Date.now());
            }
            
            const count = db.prepare('SELECT COUNT(*) as count FROM hearings').get();
            result.steps.push({ 
                step: 'data_fetch', 
                status: 'success', 
                hearings_fetched: hearings.length,
                total_in_db: count.count 
            });
            
            db.close();
            
            // Step 4: Restart the app to pick up changes
            result.restart_needed = true;
            result.success = true;
            
        } catch (e) {
            result.steps.push({ step: 'database_ops', status: 'error', error: e.message });
            result.success = false;
        }
        
        res.json(result);
        
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});