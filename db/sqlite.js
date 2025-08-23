const path = require('path');
const { spawnSync } = require('child_process');
let Database;

function tryRequireBetterSqlite3() {
    try { return require('better-sqlite3'); } catch (e) { return e; }
}

function needsRebuild(error) {
    const msg = String((error && error.message) || error || '').toLowerCase();
    return (
        msg.includes('node_module_version') ||
        msg.includes('was compiled against a different node.js version') ||
        msg.includes('invalid or incompatible binary')
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
        const hinted = detectProjectRootFromError(hintError);
        const cwd = hinted || process.cwd();
        const env = { ...process.env, npm_config_build_from_source: 'true' };
        // Best-effort: rebuild native module for the current Node runtime
        spawnSync('npm', ['rebuild', 'better-sqlite3', '--build-from-source'], {
            cwd,
            env,
            stdio: 'inherit'
        });
    } catch (_) { /* ignore */ }
}

(() => {
    const first = tryRequireBetterSqlite3();
    if (first && typeof first === 'object' && first.name) {
        // Received an Error instance
        if (needsRebuild(first) && process.env.ALLOW_RUNTIME_SQLITE_REBUILD !== '0') {
            // Try to rebuild then require again
            attemptRebuildOnce(first);
            const second = tryRequireBetterSqlite3();
            if (typeof second === 'function' || (second && second.open)) {
                Database = second;
                return;
            }
        }
        Database = null;
    } else {
        // Successfully required the module
        Database = first;
    }
})();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.sqlite');

let db = null;

function init() {
    if (!Database) {
        throw new Error('better-sqlite3 is not installed');
    }
    db = new Database(DB_PATH);
    try { db.pragma('journal_mode = WAL'); } catch (_) {}
    db.exec(`
        CREATE TABLE IF NOT EXISTS hearings(
          id INTEGER PRIMARY KEY,
          title TEXT,
          start_date TEXT,
          deadline TEXT,
          status TEXT,
          updated_at INTEGER
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
    `);
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

function replaceResponses(hearingId, responses) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM responses WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM attachments WHERE hearing_id=?`).run(hearingId);
        const insR = db.prepare(`INSERT INTO responses(hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at) VALUES (?,?,?,?,?,?,?)`);
        const insA = db.prepare(`INSERT INTO attachments(hearing_id,response_id,idx,filename,url) VALUES (?,?,?,?,?)`);
        for (const r of (responses||[])) {
            insR.run(hearingId, r.id, r.text || '', r.author || null, r.organization || null, r.onBehalfOf || null, r.submittedAt || null);
            (r.attachments||[]).forEach((a, i) => insA.run(hearingId, r.id, i, a.filename || 'Dokument', a.url || null));
        }
    });
    tx();
}

function replaceMaterials(hearingId, materials) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM materials WHERE hearing_id=?`).run(hearingId);
        const ins = db.prepare(`INSERT INTO materials(hearing_id,idx,type,title,url,content) VALUES (?,?,?,?,?,?)`);
        (materials||[]).forEach((m, i) => ins.run(hearingId, i, m.type, m.title || null, m.url || null, m.content || null));
    });
    tx();
}

function readAggregate(hearingId) {
    const hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    if (!hearing) return null;
    const responses = db.prepare(`SELECT * FROM responses WHERE hearing_id=? ORDER BY response_id ASC`).all(hearingId).map(r => ({
        id: r.response_id,
        text: r.text,
        author: r.author,
        organization: r.organization,
        onBehalfOf: r.on_behalf_of,
        submittedAt: r.submitted_at,
        attachments: db.prepare(`SELECT * FROM attachments WHERE hearing_id=? AND response_id=? ORDER BY idx ASC`).all(hearingId, r.response_id)
            .map(a => ({ filename: a.filename, url: a.url }))
    }));
    const materials = db.prepare(`SELECT * FROM materials WHERE hearing_id=? ORDER BY idx ASC`).all(hearingId)
        .map(m => ({ type: m.type, title: m.title, url: m.url, content: m.content }));
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
        materials
    };
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

module.exports = {
    db,
    init,
    upsertHearing,
    replaceResponses,
    replaceMaterials,
    readAggregate,
    getSessionEdits,
    upsertSessionEdit,
    setMaterialFlag,
    getMaterialFlags,
    addUpload,
    listUploads
};


