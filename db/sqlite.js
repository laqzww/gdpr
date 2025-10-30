const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
let Database;

function tryRequireBetterSqlite3() {
    try { return require('better-sqlite3'); } catch (e) { return e; }
}

function needsRebuild(error) {
    const msg = String((error && error.message) || error || '').toLowerCase();
    return (
        msg.includes('node_module_version') ||
        msg.includes('was compiled against a different node.js version') ||
        msg.includes('invalid or incompatible binary') ||
        msg.includes('did not self-register') ||
        msg.includes('module did not self-register')
    );
}

function detectProjectRootFromError(error) {
    try {
        const msg = String((error && error.message) || '');
        const marker = '/node_modules/better-sqlite3/';
        const idx = msg.indexOf(marker);
        if (idx > 0) {
            const prefix = msg.slice(0, idx);
            const rootIdx = prefix.lastIndexOf('/');
            const root = prefix.slice(0, rootIdx);
            if (root && root.startsWith('/')) return root;
        }
    } catch {}
    return null;
}

function attemptRebuildOnce(hintError) {
    try {
        if (attemptRebuildOnce._did) return;
        attemptRebuildOnce._did = true;
        console.log('[SQLite] Attempting runtime rebuild of better-sqlite3...');
        const hinted = detectProjectRootFromError(hintError);
        const cwd = hinted || process.cwd();
        const env = { ...process.env, npm_config_build_from_source: 'true' };
        // Best-effort: rebuild native module for the current Node runtime
        const result = spawnSync('npm', ['rebuild', 'better-sqlite3', '--build-from-source', '--unsafe-perm'], {
            cwd,
            env,
            stdio: 'inherit'
        });
        console.log('[SQLite] Rebuild attempt completed with status:', result.status);
    } catch (e) { 
        console.error('[SQLite] Rebuild attempt failed:', e.message);
    }
}

(() => {
    const first = tryRequireBetterSqlite3();
    if (first && typeof first === 'object' && first.name) {
        // Received an Error instance
        console.log('[SQLite] Initial require failed:', first.message);
        if (needsRebuild(first) && process.env.ALLOW_RUNTIME_SQLITE_REBUILD === '1') {
            console.log('[SQLite] Runtime rebuild requested but skipping to avoid hangs');
            // Skip runtime rebuild as it can hang the process
            // attemptRebuildOnce(first);
            // const second = tryRequireBetterSqlite3();
            // if (typeof second === 'function' || (second && second.open)) {
            //     console.log('[SQLite] Successfully loaded after rebuild');
            //     Database = second;
            //     return;
            // } else {
            //     console.error('[SQLite] Failed to load even after rebuild');
            // }
        }
        Database = null;
    } else {
        // Successfully required the module
        console.log('[SQLite] better-sqlite3 loaded successfully on first try');
        Database = first;
    }
})();

// Detect if running on Render by checking for RENDER environment variable
const isRender = process.env.RENDER === 'true';
// On Render, the working directory is /opt/render/project/src
// But the disk is mounted at /opt/render/project/src/fetcher/data
// Force absolute path on Render
const defaultPath = isRender 
    ? '/opt/render/project/src/fetcher/data/app.sqlite'
    : path.join(__dirname, '..', 'data', 'app.sqlite');

// If DB_PATH is set but relative, make it absolute on Render
let DB_PATH = process.env.DB_PATH || defaultPath;
if (isRender && DB_PATH && !path.isAbsolute(DB_PATH)) {
    DB_PATH = path.join('/opt/render/project/src', DB_PATH);
}

console.log('[SQLite] Environment:', {
    isRender,
    DB_PATH,
    cwd: process.cwd(),
    __dirname
});

let db = null;

function init() {
    console.log('[SQLite] Initializing database...');
    console.log('[SQLite] DB_PATH:', DB_PATH);
    console.log('[SQLite] DB directory exists:', fs.existsSync(path.dirname(DB_PATH)));
    
    if (!Database) {
        throw new Error('better-sqlite3 is not installed or failed to load. Check build logs for native module errors.');
    }
    // Attempt to open DB; if ABI mismatch occurs at instantiation, try a one-time rebuild
    try {
        // Ensure parent directory exists to avoid SQLITE_CANTOPEN errors
        try { 
            fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); 
            console.log('[SQLite] Created directory:', path.dirname(DB_PATH));
        } catch (e) {
            console.log('[SQLite] Directory creation error (may already exist):', e.message);
        }
        db = new Database(DB_PATH);
        console.log('[SQLite] Database opened successfully');
    } catch (e) {
        if (needsRebuild(e) && process.env.ALLOW_RUNTIME_SQLITE_REBUILD === '1') {
            console.log('[SQLite] Database instantiation failed with rebuild error, but skipping runtime rebuild');
            // Don't attempt runtime rebuild as it can hang
            // attemptRebuildOnce(e);
            // const re = tryRequireBetterSqlite3();
            // if (typeof re === 'function' || (re && re.open)) {
            //     Database = re;
            // }
            // // Retry once after rebuild
            // try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
            // db = new Database(DB_PATH);
        }
            throw e;
    }
    try { db.pragma('journal_mode = WAL'); } catch (_) {}
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
          total_materials INTEGER,
          last_success_at INTEGER,
          archived INTEGER
        );
        CREATE TABLE IF NOT EXISTS responses(
          hearing_id INTEGER,
          response_id INTEGER,
          text TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          PRIMARY KEY(hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS attachments(
          hearing_id INTEGER,
          response_id INTEGER,
          idx INTEGER,
          filename TEXT,
          url TEXT,
          PRIMARY KEY(hearing_id, response_id, idx)
        );
        CREATE TABLE IF NOT EXISTS materials(
          hearing_id INTEGER,
          idx INTEGER,
          type TEXT,
          title TEXT,
          url TEXT,
          content TEXT,
          PRIMARY KEY(hearing_id, idx)
        );
        CREATE TABLE IF NOT EXISTS raw_responses(
          hearing_id INTEGER,
          response_id INTEGER,
          text TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          PRIMARY KEY(hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS raw_attachments(
          hearing_id INTEGER,
          response_id INTEGER,
          idx INTEGER,
          filename TEXT,
          url TEXT,
          PRIMARY KEY(hearing_id, response_id, idx)
        );
        CREATE TABLE IF NOT EXISTS raw_materials(
          hearing_id INTEGER,
          idx INTEGER,
          type TEXT,
          title TEXT,
          url TEXT,
          content TEXT,
          PRIMARY KEY(hearing_id, idx)
        );
        CREATE TABLE IF NOT EXISTS prepared_responses(
          hearing_id INTEGER,
          prepared_id INTEGER,
          source_response_id INTEGER,
          respondent_name TEXT,
          respondent_type TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          text_md TEXT,
          has_attachments INTEGER,
          attachments_ready INTEGER,
          approved INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          approved_at INTEGER,
          notes TEXT,
          PRIMARY KEY(hearing_id, prepared_id)
        );
        CREATE TABLE IF NOT EXISTS prepared_attachments(
          hearing_id INTEGER,
          prepared_id INTEGER,
          attachment_id INTEGER,
          source_attachment_idx INTEGER,
          original_filename TEXT,
          source_url TEXT,
          converted_md TEXT,
          conversion_status TEXT,
          approved INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          approved_at INTEGER,
          notes TEXT,
          PRIMARY KEY(hearing_id, prepared_id, attachment_id)
        );
        CREATE TABLE IF NOT EXISTS prepared_materials(
          hearing_id INTEGER,
          material_id INTEGER,
          title TEXT,
          source_filename TEXT,
          source_url TEXT,
          content_md TEXT,
          uploaded_path TEXT,
          approved INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          approved_at INTEGER,
          notes TEXT,
          PRIMARY KEY(hearing_id, material_id)
        );
        CREATE TABLE IF NOT EXISTS published_responses(
          hearing_id INTEGER,
          response_id INTEGER,
          source_response_id INTEGER,
          respondent_name TEXT,
          respondent_type TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          text TEXT,
          text_md TEXT,
          has_attachments INTEGER,
          approved_at INTEGER,
          published_at INTEGER,
          PRIMARY KEY(hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS published_attachments(
          hearing_id INTEGER,
          response_id INTEGER,
          attachment_id INTEGER,
          original_filename TEXT,
          content_md TEXT,
          approved_at INTEGER,
          published_at INTEGER,
          PRIMARY KEY(hearing_id, response_id, attachment_id)
        );
        CREATE TABLE IF NOT EXISTS published_materials(
          hearing_id INTEGER,
          material_id INTEGER,
          title TEXT,
          content_md TEXT,
          approved_at INTEGER,
          published_at INTEGER,
          PRIMARY KEY(hearing_id, material_id)
        );
        CREATE TABLE IF NOT EXISTS hearing_preparation_state(
          hearing_id INTEGER PRIMARY KEY,
          status TEXT,
          responses_ready INTEGER,
          materials_ready INTEGER,
          vector_store_id TEXT,
          vector_store_updated_at INTEGER,
          last_modified_at INTEGER,
          published_at INTEGER,
          prepared_by TEXT,
          notes TEXT
        );
        CREATE TABLE IF NOT EXISTS vector_chunks(
          hearing_id INTEGER,
          chunk_id TEXT,
          source TEXT,
          content TEXT,
          embedding TEXT,
          created_at INTEGER,
          PRIMARY KEY(hearing_id, chunk_id)
        );
        CREATE TABLE IF NOT EXISTS hearing_index(
          id INTEGER PRIMARY KEY,
          title TEXT,
          start_date TEXT,
          deadline TEXT,
          status TEXT,
          normalized_title TEXT,
          title_tokens TEXT,
          deadline_ts INTEGER,
          is_open INTEGER,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS session_edits(
          session_id TEXT,
          hearing_id INTEGER,
          response_id INTEGER,
          respondent_name TEXT,
          respondent_type TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          text TEXT,
          PRIMARY KEY(session_id, hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS session_materials(
          session_id TEXT,
          hearing_id INTEGER,
          idx INTEGER,
          included INTEGER,
          PRIMARY KEY(session_id, hearing_id, idx)
        );
        CREATE TABLE IF NOT EXISTS session_uploads(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          hearing_id INTEGER,
          stored_path TEXT,
          original_name TEXT,
          uploaded_at INTEGER
        );
        -- Background jobs for summarization
        CREATE TABLE IF NOT EXISTS jobs(
          job_id TEXT PRIMARY KEY,
          hearing_id INTEGER,
          state TEXT,
          phase TEXT,
          progress INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          idempotency_key TEXT,
          input_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
        CREATE INDEX IF NOT EXISTS idx_jobs_hearing ON jobs(hearing_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS job_variants(
          job_id TEXT,
          variant INTEGER,
          state TEXT,
          phase TEXT,
          progress INTEGER,
          response_id TEXT,
          markdown TEXT,
          summary TEXT,
          headings_json TEXT,
          partial_chars INTEGER,
          error TEXT,
          updated_at INTEGER,
          PRIMARY KEY(job_id, variant)
        );
        CREATE INDEX IF NOT EXISTS idx_job_variants_state ON job_variants(job_id, state);

        CREATE TABLE IF NOT EXISTS job_events(
          job_id TEXT,
          ts INTEGER,
          level TEXT,
          message TEXT,
          data_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, ts);
        CREATE INDEX IF NOT EXISTS idx_raw_responses_hearing ON raw_responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_prepared_responses_hearing ON prepared_responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_published_responses_hearing ON published_responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_prepared_materials_hearing ON prepared_materials(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_published_materials_hearing ON published_materials(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_vector_chunks_hearing ON vector_chunks(hearing_id);
    `);
    try { bootstrapLegacyData(); } catch (e) { console.error('[SQLite] Legacy bootstrap failed:', e.message); }
    // Best-effort migrations to add new columns if they don't exist
    try { db.exec(`ALTER TABLE hearings ADD COLUMN complete INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN signature TEXT`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN total_responses INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN total_materials INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN last_success_at INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN archived INTEGER`); } catch (_) {}
}

function upsertHearing(hearing) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO hearings(id,title,start_date,deadline,status,updated_at)
      VALUES (@id,@title,@startDate,@deadline,@status,@now)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        start_date=excluded.start_date,
        deadline=excluded.deadline,
        status=excluded.status,
        updated_at=excluded.updated_at
    `).run({ ...hearing, now });
}

function markHearingComplete(hearingId, signature, totalResponses, totalMaterials) {
    const now = Date.now();
    db.prepare(`UPDATE hearings SET complete=1, signature=?, total_responses=?, total_materials=?, last_success_at=?, updated_at=? WHERE id=?`)
      .run(signature || null, Number(totalResponses)||0, Number(totalMaterials)||0, now, now, hearingId);
}

function isHearingComplete(hearingId) {
    const row = db.prepare(`SELECT complete, signature, total_responses as totalResponses, total_materials as totalMaterials FROM hearings WHERE id=?`).get(hearingId);
    if (!row) return { complete: false };
    return { complete: !!row.complete, signature: row.signature || null, totalResponses: row.totalResponses||0, totalMaterials: row.totalMaterials||0 };
}

function setHearingArchived(hearingId, archived) {
    const now = Date.now();
    db.prepare(`UPDATE hearings SET archived=?, updated_at=? WHERE id=?`).run(archived ? 1 : 0, now, hearingId);
}

function updateHearingIndex(hearingIndexData) {
    const now = Date.now();
    const tx = db.transaction(() => {
        // Clear existing index
        db.prepare(`DELETE FROM hearing_index`).run();
        
        // Insert new index entries
        const stmt = db.prepare(`
            INSERT INTO hearing_index(id, title, start_date, deadline, status, normalized_title, title_tokens, deadline_ts, is_open, updated_at)
            VALUES (@id, @title, @startDate, @deadline, @status, @normalizedTitle, @titleTokens, @deadlineTs, @isOpen, @now)
        `);
        
        for (const hearing of hearingIndexData) {
            stmt.run({
                id: hearing.id,
                title: hearing.title || `Høring ${hearing.id}`,
                startDate: hearing.startDate,
                deadline: hearing.deadline,
                status: hearing.status,
                normalizedTitle: hearing.normalizedTitle,
                titleTokens: JSON.stringify(hearing.titleTokens || []),
                deadlineTs: hearing.deadlineTs,
                isOpen: hearing.isOpen ? 1 : 0,
                now
            });
        }
    });
    tx();
}

function getHearingIndex() {
    const rows = db.prepare(`
        SELECT id, title, start_date as startDate, deadline, status, 
               normalized_title as normalizedTitle, title_tokens as titleTokens,
               deadline_ts as deadlineTs, is_open as isOpen
        FROM hearing_index
        ORDER BY deadline_ts ASC, id ASC
    `).all();
    
    return rows.map(row => ({
        ...row,
        titleTokens: row.titleTokens ? JSON.parse(row.titleTokens) : [],
        isOpen: !!row.isOpen
    }));
}

function listHearingsByStatusLike(statusLike) {
    const s = `%${String(statusLike || '').toLowerCase()}%`;
    return db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE ? ORDER BY deadline ASC, id ASC`).all(s);
}

function listIncompleteHearings() {
    return db.prepare(`SELECT id FROM hearings WHERE archived IS NOT 1 AND (complete IS NULL OR complete=0)`).all().map(r => r.id);
}

function listAllHearingIds() {
    return db.prepare(`SELECT id FROM hearings`).all().map(r => r.id);
}

function replaceRawResponses(hearingId, responses) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM raw_responses WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM raw_attachments WHERE hearing_id=?`).run(hearingId);
        const insR = db.prepare(`INSERT INTO raw_responses(hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at) VALUES (?,?,?,?,?,?,?)`);
        const insA = db.prepare(`INSERT INTO raw_attachments(hearing_id,response_id,idx,filename,url) VALUES (?,?,?,?,?)`);
        for (const r of (responses||[])) {
            const responseId = typeof r.id === 'number' || typeof r.id === 'string' ? r.id : r.responseId;
            if (typeof responseId === 'undefined') continue;
            insR.run(hearingId, Number(responseId), r.text || '', r.author || null, r.organization || null, r.onBehalfOf || null, r.submittedAt || null);
            (r.attachments||[]).forEach((a, i) => insA.run(hearingId, Number(responseId), i, a.filename || 'Dokument', a.url || null));
        }
    });
    tx();
}

function replaceResponses(hearingId, responses) {
    replaceRawResponses(hearingId, responses);
}

function replaceRawMaterials(hearingId, materials) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM raw_materials WHERE hearing_id=?`).run(hearingId);
        const ins = db.prepare(`INSERT INTO raw_materials(hearing_id,idx,type,title,url,content) VALUES (?,?,?,?,?,?)`);
        (materials||[]).forEach((m, i) => ins.run(hearingId, i, m.type, m.title || null, m.url || null, m.content || null));
    });
    tx();
}

function replaceMaterials(hearingId, materials) {
    replaceRawMaterials(hearingId, materials);
}

function bootstrapLegacyData() {
    if (!db) return;
    try {
        const legacyCount = db.prepare(`SELECT COUNT(*) as c FROM responses`).get().c || 0;
        const rawCount = db.prepare(`SELECT COUNT(*) as c FROM raw_responses`).get().c || 0;
        if (legacyCount && !rawCount) {
            const tx = db.transaction(() => {
                db.prepare(`INSERT INTO raw_responses(hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at) SELECT hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at FROM responses`).run();
                db.prepare(`INSERT INTO raw_attachments(hearing_id,response_id,idx,filename,url) SELECT hearing_id,response_id,idx,filename,url FROM attachments`).run();
                db.prepare(`INSERT INTO raw_materials(hearing_id,idx,type,title,url,content) SELECT hearing_id,idx,type,title,url,content FROM materials`).run();
            });
            tx();
        }

        const publishedCount = db.prepare(`SELECT COUNT(*) as c FROM published_responses`).get().c || 0;
        if (legacyCount && !publishedCount) {
            const selectResponses = db.prepare(`SELECT hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at FROM responses ORDER BY hearing_id,response_id`);
            const attachmentCountStmt = db.prepare(`SELECT COUNT(*) as c FROM attachments WHERE hearing_id=? AND response_id=?`);
            const insertPublished = db.prepare(`INSERT INTO published_responses(hearing_id,response_id,source_response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text,text_md,has_attachments,approved_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
            const now = Date.now();
            const tx = db.transaction(() => {
                for (const row of selectResponses.iterate()) {
                    const count = attachmentCountStmt.get(row.hearing_id, row.response_id)?.c || 0;
                    insertPublished.run(
                        row.hearing_id,
                        row.response_id,
                        row.response_id,
                        row.author || null,
                        null,
                        row.author || null,
                        row.organization || null,
                        row.on_behalf_of || null,
                        row.submitted_at || null,
                        row.text || '',
                        row.text || '',
                        count ? 1 : 0,
                        null,
                        now
                    );
                }
                db.prepare(`INSERT INTO published_attachments(hearing_id,response_id,attachment_id,original_filename,content_md,approved_at,published_at)
                             SELECT hearing_id,response_id,idx,filename,NULL,NULL,? FROM attachments`).run(now);
                db.prepare(`INSERT INTO published_materials(hearing_id,material_id,title,content_md,approved_at,published_at)
                             SELECT hearing_id,idx,title,content,NULL,? FROM materials`).run(now);
            });
            tx();
        }
    } catch (err) {
        console.error('[SQLite] bootstrapLegacyData error:', err.message);
    }
}

function getRawAggregate(hearingId) {
    const responses = db.prepare(`SELECT * FROM raw_responses WHERE hearing_id=? ORDER BY response_id ASC`).all(hearingId).map(r => ({
        id: r.response_id,
        text: r.text,
        author: r.author,
        organization: r.organization,
        onBehalfOf: r.on_behalf_of,
        submittedAt: r.submitted_at,
        attachments: db.prepare(`SELECT * FROM raw_attachments WHERE hearing_id=? AND response_id=? ORDER BY idx ASC`).all(hearingId, r.response_id)
            .map(a => ({ attachmentId: a.idx, filename: a.filename, url: a.url }))
    }));
    const materials = db.prepare(`SELECT * FROM raw_materials WHERE hearing_id=? ORDER BY idx ASC`).all(hearingId)
        .map(m => ({ materialId: m.idx, type: m.type, title: m.title, url: m.url, content: m.content }));
    return { responses, materials };
}

function getPublishedAggregate(hearingId) {
    const responses = db.prepare(`SELECT * FROM published_responses WHERE hearing_id=? ORDER BY response_id ASC`).all(hearingId).map(r => ({
        id: r.response_id,
        sourceId: r.source_response_id,
        text: r.text || r.text_md || '',
        textMd: r.text_md || r.text || '',
        respondentName: r.respondent_name || r.author || null,
        respondentType: r.respondent_type || null,
        author: r.author,
        organization: r.organization,
        onBehalfOf: r.on_behalf_of,
        submittedAt: r.submitted_at,
        hasAttachments: !!r.has_attachments,
        attachments: db.prepare(`SELECT * FROM published_attachments WHERE hearing_id=? AND response_id=? ORDER BY attachment_id ASC`).all(hearingId, r.response_id)
            .map(a => ({ attachmentId: a.attachment_id, filename: a.original_filename, contentMd: a.content_md, publishedAt: a.published_at }))
    }));
    const materials = db.prepare(`SELECT * FROM published_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId)
        .map(m => ({ materialId: m.material_id, title: m.title, contentMd: m.content_md, publishedAt: m.published_at }));
    return { responses, materials };
}

function readAggregate(hearingId) {
    const hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    if (!hearing) return null;
    const published = getPublishedAggregate(hearingId);
    const usePublished = Array.isArray(published.responses) && published.responses.length;
    const source = usePublished ? published : getRawAggregate(hearingId);
    const responses = (source.responses || []).map(r => ({
        id: r.id,
        text: r.text,
        textMd: r.textMd || r.text,
        author: r.author || r.respondentName || null,
        respondentName: r.respondentName || r.author || null,
        respondentType: r.respondentType || null,
        organization: r.organization,
        onBehalfOf: r.onBehalfOf,
        submittedAt: r.submittedAt,
        hasAttachments: typeof r.hasAttachments === 'boolean' ? r.hasAttachments : Array.isArray(r.attachments) && r.attachments.length > 0,
        attachments: (r.attachments || []).map(a => ({
            attachmentId: a.attachmentId,
            filename: a.filename,
            url: a.url || null,
            contentMd: a.contentMd || null,
            publishedAt: a.publishedAt || null
        }))
    }));
    const materials = (source.materials || []).map(m => ({
        materialId: m.materialId,
        type: m.type,
        title: m.title,
        url: m.url || null,
        content: m.content || m.contentMd || null,
        contentMd: m.contentMd || m.content || null,
        publishedAt: m.publishedAt || null
    }));
    return {
        hearing: {
            id: hearing.id,
            title: hearing.title,
            startDate: hearing.start_date,
            deadline: hearing.deadline,
            status: hearing.status,
            url: `https://blivhoert.kk.dk/hearing/${hearing.id}/comments`
        },
        responses,
        materials,
        source: usePublished ? 'published' : 'raw'
    };
}

function getPreparationState(hearingId) {
    const row = db.prepare(`SELECT * FROM hearing_preparation_state WHERE hearing_id=?`).get(hearingId);
    if (row) return row;
    return {
        hearing_id: hearingId,
        status: 'draft',
        responses_ready: 0,
        materials_ready: 0,
        vector_store_id: null,
        vector_store_updated_at: null,
        last_modified_at: null,
        published_at: null,
        prepared_by: null,
        notes: null
    };
}

function updatePreparationState(hearingId, patch) {
    const now = Date.now();
    const current = getPreparationState(hearingId);
    const payload = {
        status: patch.status !== undefined ? patch.status : current.status,
        responses_ready: patch.responses_ready !== undefined ? patch.responses_ready : current.responses_ready,
        materials_ready: patch.materials_ready !== undefined ? patch.materials_ready : current.materials_ready,
        vector_store_id: patch.vector_store_id !== undefined ? patch.vector_store_id : current.vector_store_id,
        vector_store_updated_at: patch.vector_store_updated_at !== undefined ? patch.vector_store_updated_at : current.vector_store_updated_at,
        last_modified_at: patch.last_modified_at !== undefined ? patch.last_modified_at : now,
        published_at: patch.published_at !== undefined ? patch.published_at : current.published_at,
        prepared_by: patch.prepared_by !== undefined ? patch.prepared_by : current.prepared_by,
        notes: patch.notes !== undefined ? patch.notes : current.notes
    };
    db.prepare(`
        INSERT INTO hearing_preparation_state(hearing_id,status,responses_ready,materials_ready,vector_store_id,vector_store_updated_at,last_modified_at,published_at,prepared_by,notes)
        VALUES (@hearingId,@status,@responses_ready,@materials_ready,@vector_store_id,@vector_store_updated_at,@last_modified_at,@published_at,@prepared_by,@notes)
        ON CONFLICT(hearing_id) DO UPDATE SET
          status=excluded.status,
          responses_ready=excluded.responses_ready,
          materials_ready=excluded.materials_ready,
          vector_store_id=excluded.vector_store_id,
          vector_store_updated_at=excluded.vector_store_updated_at,
          last_modified_at=excluded.last_modified_at,
          published_at=excluded.published_at,
          prepared_by=excluded.prepared_by,
          notes=excluded.notes
    `).run({ hearingId, ...payload });
    return getPreparationState(hearingId);
}

function recalcPreparationProgress(hearingId) {
    const totalResponses = db.prepare(`SELECT COUNT(*) as c FROM prepared_responses WHERE hearing_id=?`).get(hearingId)?.c || 0;
    const approvedResponses = db.prepare(`SELECT COUNT(*) as c FROM prepared_responses WHERE hearing_id=? AND approved=1`).get(hearingId)?.c || 0;
    const totalMaterials = db.prepare(`SELECT COUNT(*) as c FROM prepared_materials WHERE hearing_id=?`).get(hearingId)?.c || 0;
    const approvedMaterials = db.prepare(`SELECT COUNT(*) as c FROM prepared_materials WHERE hearing_id=? AND approved=1`).get(hearingId)?.c || 0;
    const responsesReady = totalResponses > 0 && totalResponses === approvedResponses ? 1 : 0;
    const materialsReady = totalMaterials > 0 && totalMaterials === approvedMaterials ? 1 : 0;
    let status = 'draft';
    if (responsesReady || materialsReady) status = 'in-progress';
    if (responsesReady && materialsReady) status = 'ready';
    const state = updatePreparationState(hearingId, { responses_ready: responsesReady, materials_ready: materialsReady, status, last_modified_at: Date.now() });
    return state;
}

function upsertPreparedResponse(hearingId, preparedId, payload) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO prepared_responses(hearing_id,prepared_id,source_response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text_md,has_attachments,attachments_ready,approved,created_at,updated_at,approved_at,notes)
      VALUES (@hearingId,@preparedId,@source_response_id,@respondent_name,@respondent_type,@author,@organization,@on_behalf_of,@submitted_at,@text_md,@has_attachments,@attachments_ready,@approved,@created_at,@updated_at,@approved_at,@notes)
      ON CONFLICT(hearing_id,prepared_id) DO UPDATE SET
        source_response_id=excluded.source_response_id,
        respondent_name=excluded.respondent_name,
        respondent_type=excluded.respondent_type,
        author=excluded.author,
        organization=excluded.organization,
        on_behalf_of=excluded.on_behalf_of,
        submitted_at=excluded.submitted_at,
        text_md=excluded.text_md,
        has_attachments=excluded.has_attachments,
        attachments_ready=excluded.attachments_ready,
        approved=excluded.approved,
        updated_at=excluded.updated_at,
        approved_at=excluded.approved_at,
        notes=excluded.notes
    `).run({
        hearingId,
        preparedId,
        source_response_id: payload?.sourceResponseId ?? null,
        respondent_name: payload?.respondentName ?? null,
        respondent_type: payload?.respondentType ?? null,
        author: payload?.author ?? null,
        organization: payload?.organization ?? null,
        on_behalf_of: payload?.onBehalfOf ?? null,
        submitted_at: payload?.submittedAt ?? null,
        text_md: payload?.textMd ?? payload?.text ?? '',
        has_attachments: payload?.hasAttachments ? 1 : 0,
        attachments_ready: payload?.attachmentsReady ? 1 : 0,
        approved: payload?.approved ? 1 : 0,
        created_at: payload?.createdAt || now,
        updated_at: now,
        approved_at: payload?.approved ? (payload?.approvedAt || now) : null,
        notes: payload?.notes ?? null
    });
    const state = recalcPreparationProgress(hearingId);
    return { state };
}

function deletePreparedResponse(hearingId, preparedId) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, preparedId);
        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, preparedId);
    });
    tx();
    return recalcPreparationProgress(hearingId);
}

function upsertPreparedAttachment(hearingId, preparedId, attachmentId, payload) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO prepared_attachments(hearing_id,prepared_id,attachment_id,source_attachment_idx,original_filename,source_url,converted_md,conversion_status,approved,created_at,updated_at,approved_at,notes)
      VALUES (@hearingId,@preparedId,@attachmentId,@source_attachment_idx,@original_filename,@source_url,@converted_md,@conversion_status,@approved,@created_at,@updated_at,@approved_at,@notes)
      ON CONFLICT(hearing_id,prepared_id,attachment_id) DO UPDATE SET
        source_attachment_idx=excluded.source_attachment_idx,
        original_filename=excluded.original_filename,
        source_url=excluded.source_url,
        converted_md=excluded.converted_md,
        conversion_status=excluded.conversion_status,
        approved=excluded.approved,
        updated_at=excluded.updated_at,
        approved_at=excluded.approved_at,
        notes=excluded.notes
    `).run({
        hearingId,
        preparedId,
        attachmentId,
        source_attachment_idx: payload?.sourceAttachmentIdx ?? null,
        original_filename: payload?.originalFilename ?? null,
        source_url: payload?.sourceUrl ?? null,
        converted_md: payload?.convertedMd ?? null,
        conversion_status: payload?.conversionStatus ?? null,
        approved: payload?.approved ? 1 : 0,
        created_at: payload?.createdAt || now,
        updated_at: now,
        approved_at: payload?.approved ? (payload?.approvedAt || now) : null,
        notes: payload?.notes ?? null
    });
    return recalcPreparationProgress(hearingId);
}

function deletePreparedAttachment(hearingId, preparedId, attachmentId) {
    db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=? AND attachment_id=?`).run(hearingId, preparedId, attachmentId);
    return recalcPreparationProgress(hearingId);
}

function upsertPreparedMaterial(hearingId, materialId, payload) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO prepared_materials(hearing_id,material_id,title,source_filename,source_url,content_md,uploaded_path,approved,created_at,updated_at,approved_at,notes)
      VALUES (@hearingId,@materialId,@title,@source_filename,@source_url,@content_md,@uploaded_path,@approved,@created_at,@updated_at,@approved_at,@notes)
      ON CONFLICT(hearing_id,material_id) DO UPDATE SET
        title=excluded.title,
        source_filename=excluded.source_filename,
        source_url=excluded.source_url,
        content_md=excluded.content_md,
        uploaded_path=excluded.uploaded_path,
        approved=excluded.approved,
        updated_at=excluded.updated_at,
        approved_at=excluded.approved_at,
        notes=excluded.notes
    `).run({
        hearingId,
        materialId,
        title: payload?.title ?? null,
        source_filename: payload?.sourceFilename ?? null,
        source_url: payload?.sourceUrl ?? null,
        content_md: payload?.contentMd ?? payload?.content ?? null,
        uploaded_path: payload?.uploadedPath ?? null,
        approved: payload?.approved ? 1 : 0,
        created_at: payload?.createdAt || now,
        updated_at: now,
        approved_at: payload?.approved ? (payload?.approvedAt || now) : null,
        notes: payload?.notes ?? null
    });
    return recalcPreparationProgress(hearingId);
}

function deletePreparedMaterial(hearingId, materialId) {
    db.prepare(`DELETE FROM prepared_materials WHERE hearing_id=? AND material_id=?`).run(hearingId, materialId);
    return recalcPreparationProgress(hearingId);
}

function listPreparedHearings() {
    const baseRows = db.prepare(`
        SELECT h.id,h.title,h.status,h.deadline,h.start_date,h.updated_at,s.status as prep_status,s.responses_ready,s.materials_ready,s.last_modified_at,s.published_at,s.vector_store_id,s.vector_store_updated_at
        FROM hearings h
        LEFT JOIN hearing_preparation_state s ON s.hearing_id = h.id
        ORDER BY h.deadline ASC, h.id ASC
    `).all();
    const mapCounts = (rows) => {
        const out = new Map();
        for (const row of rows) out.set(row.hearing_id, row.count);
        return out;
    };
    const rawCounts = mapCounts(db.prepare(`SELECT hearing_id, COUNT(*) as count FROM raw_responses GROUP BY hearing_id`).all());
    const preparedCounts = mapCounts(db.prepare(`SELECT hearing_id, COUNT(*) as count FROM prepared_responses GROUP BY hearing_id`).all());
    const publishedCounts = mapCounts(db.prepare(`SELECT hearing_id, COUNT(*) as count FROM published_responses GROUP BY hearing_id`).all());
    return baseRows.map(row => ({
        hearingId: row.id,
        title: row.title,
        status: row.status,
        deadline: row.deadline,
        startDate: row.start_date,
        updatedAt: row.updated_at,
        preparation: {
            status: row.prep_status || 'draft',
            responsesReady: !!row.responses_ready,
            materialsReady: !!row.materials_ready,
            lastModifiedAt: row.last_modified_at || null,
            publishedAt: row.published_at || null,
            vectorStoreId: row.vector_store_id || null,
            vectorStoreUpdatedAt: row.vector_store_updated_at || null
        },
        counts: {
            rawResponses: rawCounts.get(row.id) || 0,
            preparedResponses: preparedCounts.get(row.id) || 0,
            publishedResponses: publishedCounts.get(row.id) || 0
        }
    }));
}

function getPreparedBundle(hearingId) {
    const hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    if (!hearing) return null;
    const state = getPreparationState(hearingId);
    const preparedResponses = db.prepare(`SELECT * FROM prepared_responses WHERE hearing_id=? ORDER BY prepared_id ASC`).all(hearingId);
    const preparedAttachments = db.prepare(`SELECT * FROM prepared_attachments WHERE hearing_id=? ORDER BY prepared_id ASC, attachment_id ASC`).all(hearingId);
    const preparedMaterials = db.prepare(`SELECT * FROM prepared_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId);
    const attachmentsByResponse = new Map();
    for (const att of preparedAttachments) {
        const key = att.prepared_id;
        if (!attachmentsByResponse.has(key)) attachmentsByResponse.set(key, []);
        attachmentsByResponse.get(key).push(att);
    }
    const prepared = {
        responses: preparedResponses.map(r => ({
            preparedId: r.prepared_id,
            sourceResponseId: r.source_response_id,
            respondentName: r.respondent_name,
            respondentType: r.respondent_type,
            author: r.author,
            organization: r.organization,
            onBehalfOf: r.on_behalf_of,
            submittedAt: r.submitted_at,
            textMd: r.text_md,
            hasAttachments: !!r.has_attachments,
            attachmentsReady: !!r.attachments_ready,
            approved: !!r.approved,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            approvedAt: r.approved_at,
            notes: r.notes,
            attachments: (attachmentsByResponse.get(r.prepared_id) || []).map(a => ({
                attachmentId: a.attachment_id,
                sourceAttachmentIdx: a.source_attachment_idx,
                originalFilename: a.original_filename,
                sourceUrl: a.source_url,
                convertedMd: a.converted_md,
                conversionStatus: a.conversion_status,
                approved: !!a.approved,
                createdAt: a.created_at,
                updatedAt: a.updated_at,
                approvedAt: a.approved_at,
                notes: a.notes
            }))
        })),
        materials: preparedMaterials.map(m => ({
            materialId: m.material_id,
            title: m.title,
            sourceFilename: m.source_filename,
            sourceUrl: m.source_url,
            contentMd: m.content_md,
            uploadedPath: m.uploaded_path,
            approved: !!m.approved,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
            approvedAt: m.approved_at,
            notes: m.notes
        }))
    };
    const raw = getRawAggregate(hearingId);
    const published = getPublishedAggregate(hearingId);
    return {
        hearing: {
            id: hearing.id,
            title: hearing.title,
            startDate: hearing.start_date,
            deadline: hearing.deadline,
            status: hearing.status
        },
        state,
        prepared,
        raw,
        published
    };
}

function publishPreparedHearing(hearingId, options = {}) {
    const prepared = db.prepare(`SELECT * FROM prepared_responses WHERE hearing_id=? ORDER BY prepared_id ASC`).all(hearingId);
    const materials = db.prepare(`SELECT * FROM prepared_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId);
    const attachments = db.prepare(`SELECT * FROM prepared_attachments WHERE hearing_id=? ORDER BY prepared_id ASC, attachment_id ASC`).all(hearingId);
    const now = Date.now();
    const onlyApproved = options.onlyApproved !== false;
    const includeResponse = (r) => !onlyApproved || r.approved;
    const includeMaterial = (m) => !onlyApproved || m.approved;
    const groupedAttachments = new Map();
    for (const att of attachments) {
        if (onlyApproved && !att.approved) continue;
        if (!groupedAttachments.has(att.prepared_id)) groupedAttachments.set(att.prepared_id, []);
        groupedAttachments.get(att.prepared_id).push(att);
    }
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM published_responses WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM published_attachments WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM published_materials WHERE hearing_id=?`).run(hearingId);

        const insertResp = db.prepare(`INSERT INTO published_responses(hearing_id,response_id,source_response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text,text_md,has_attachments,approved_at,published_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insertAtt = db.prepare(`INSERT INTO published_attachments(hearing_id,response_id,attachment_id,original_filename,content_md,approved_at,published_at) VALUES (?,?,?,?,?,?,?)`);
        let responseCounter = 0;
        for (const r of prepared) {
            if (!includeResponse(r)) continue;
            responseCounter += 1;
            const responseId = responseCounter;
            const atts = groupedAttachments.get(r.prepared_id) || [];
            insertResp.run(
                hearingId,
                responseId,
                r.source_response_id,
                r.respondent_name || r.author || null,
                r.respondent_type || null,
                r.author || null,
                r.organization || null,
                r.on_behalf_of || null,
                r.submitted_at || null,
                r.text_md || '',
                r.text_md || '',
                atts.length ? 1 : 0,
                r.approved ? (r.approved_at || now) : null,
                now
            );
            if (atts.length) {
                atts.forEach((a, idx) => {
                    insertAtt.run(hearingId, responseId, idx + 1, a.original_filename || `Bilag ${idx + 1}`, a.converted_md || null, a.approved ? (a.approved_at || now) : null, now);
                });
            }
        }

        const insertMat = db.prepare(`INSERT INTO published_materials(hearing_id,material_id,title,content_md,approved_at,published_at) VALUES (?,?,?,?,?,?)`);
        let matCounter = 0;
        for (const m of materials) {
            if (!includeMaterial(m)) continue;
            matCounter += 1;
            insertMat.run(hearingId, matCounter, m.title || `Materiale ${matCounter}`, m.content_md || null, m.approved ? (m.approved_at || now) : null, now);
        }
    });
    tx();

    const afterState = updatePreparationState(hearingId, {
        status: 'published',
        published_at: now,
        last_modified_at: now
    });

    try {
        const publishedAggregate = getPublishedAggregate(hearingId);
        const totalResponses = publishedAggregate.responses ? publishedAggregate.responses.length : 0;
        const totalMaterials = publishedAggregate.materials ? publishedAggregate.materials.length : 0;
        markHearingComplete(hearingId, 'manual-publish', totalResponses, totalMaterials);
    } catch (err) {
        console.error('[SQLite] publishPreparedHearing mark complete failed:', err.message);
    }

    return afterState;
}

function replaceVectorChunks(hearingId, chunks) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(hearingId);
        const insert = db.prepare(`INSERT INTO vector_chunks(hearing_id,chunk_id,source,content,embedding,created_at) VALUES (?,?,?,?,?,?)`);
        const createdAt = Date.now();
        for (const chunk of chunks || []) {
            insert.run(
                hearingId,
                chunk.chunkId || chunk.id || cryptoRandomId(),
                chunk.source || null,
                chunk.content || '',
                JSON.stringify(chunk.embedding || []),
                createdAt
            );
        }
    });
    tx();
}

function listVectorChunks(hearingId) {
    const rows = db.prepare(`SELECT chunk_id as chunkId, source, content, embedding FROM vector_chunks WHERE hearing_id=? ORDER BY created_at ASC`).all(hearingId);
    return rows.map(row => ({
        chunkId: row.chunkId,
        source: row.source || null,
        content: row.content || '',
        embedding: row.embedding ? JSON.parse(row.embedding) : []
    }));
}

function cryptoRandomId() {
    try {
        return crypto.randomUUID();
    } catch (_) {
        return Math.random().toString(36).slice(2);
    }
}


function getSessionEdits(sessionId, hearingId) {
    const rows = db.prepare(`SELECT * FROM session_edits WHERE session_id=? AND hearing_id=?`).all(sessionId, hearingId);
    const map = {};
    for (const r of rows) {
        map[r.response_id] = {
            respondentName: r.respondent_name || undefined,
            respondentType: r.respondent_type || undefined,
            author: r.author || undefined,
            organization: r.organization || undefined,
            onBehalfOf: r.on_behalf_of || undefined,
            submittedAt: r.submitted_at || undefined,
            text: r.text || undefined
        };
    }
    return map;
}

function upsertSessionEdit(sessionId, hearingId, responseId, patch) {
    db.prepare(`
      INSERT INTO session_edits(session_id,hearing_id,response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text)
      VALUES (@sessionId,@hearingId,@responseId,@respondentName,@respondentType,@author,@organization,@onBehalfOf,@submittedAt,@text)
      ON CONFLICT(session_id,hearing_id,response_id) DO UPDATE SET
        respondent_name=excluded.respondent_name,
        respondent_type=excluded.respondent_type,
        author=excluded.author,
        organization=excluded.organization,
        on_behalf_of=excluded.on_behalf_of,
        submitted_at=excluded.submitted_at,
        text=excluded.text
    `).run({ sessionId, hearingId, responseId, ...patch });
}

function setMaterialFlag(sessionId, hearingId, idx, included) {
    db.prepare(`
      INSERT INTO session_materials(session_id,hearing_id,idx,included)
      VALUES (?,?,?,?)
      ON CONFLICT(session_id,hearing_id,idx) DO UPDATE SET included=excluded.included
    `).run(sessionId, hearingId, idx, included ? 1 : 0);
}

function getMaterialFlags(sessionId, hearingId) {
    const rows = db.prepare(`SELECT idx,included FROM session_materials WHERE session_id=? AND hearing_id=?`).all(sessionId, hearingId);
    const flags = {};
    rows.forEach(r => { flags[r.idx] = !!r.included; });
    return flags;
}

function addUpload(sessionId, hearingId, stored_path, original_name) {
    db.prepare(`INSERT INTO session_uploads(session_id,hearing_id,stored_path,original_name,uploaded_at) VALUES (?,?,?,?,?)`)
      .run(sessionId, hearingId, stored_path, original_name, Date.now());
}

function listUploads(sessionId, hearingId) {
    return db.prepare(`SELECT id,stored_path as path,original_name as originalName,uploaded_at as uploadedAt FROM session_uploads WHERE session_id=? AND hearing_id=? ORDER BY id ASC`)
      .all(sessionId, hearingId);
}

// Export an API object with a live getter for `db` so callers always see the current handle
const api = {
    DB_PATH,
    init,
    upsertHearing,
    replaceRawResponses,
    replaceResponses,
    replaceRawMaterials,
    replaceMaterials,
    readAggregate,
    getRawAggregate,
    getPublishedAggregate,
    getPreparationState,
    updatePreparationState,
    recalcPreparationProgress,
    upsertPreparedResponse,
    deletePreparedResponse,
    upsertPreparedAttachment,
    deletePreparedAttachment,
    upsertPreparedMaterial,
    deletePreparedMaterial,
    listPreparedHearings,
    getPreparedBundle,
    publishPreparedHearing,
    replaceVectorChunks,
    listVectorChunks,
    markHearingComplete,
    isHearingComplete,
    setHearingArchived,
    listHearingsByStatusLike,
    listIncompleteHearings,
    listAllHearingIds,
    getSessionEdits,
    upsertSessionEdit,
    setMaterialFlag,
    getMaterialFlags,
    addUpload,
    listUploads,
    updateHearingIndex,
    getHearingIndex
};
Object.defineProperty(api, 'db', { get: () => db });
module.exports = api;


