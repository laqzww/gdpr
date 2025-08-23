// Polyfill for File object in Node.js environments
if (typeof File === 'undefined') {
    global.File = class File {};
}

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
// Ensure .env is loaded from this folder, regardless of current working directory
try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
    try { require('dotenv').config(); } catch (_) {}
}
let OpenAILib = null;
try { OpenAILib = require('openai'); } catch (_) { OpenAILib = null; }
const multer = require('multer');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cron = require('node-cron');
const { init: initDb, db: sqliteDb, upsertHearing, replaceResponses, replaceMaterials, readAggregate, getSessionEdits, upsertSessionEdit, setMaterialFlag, getMaterialFlags, addUpload, listUploads } = require('./db/sqlite');

// OpenAI client (optional). If library or key is missing, summarization endpoints will return an error.
const openai = OpenAILib && (process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_KEY)
    ? new OpenAILib({ apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_KEY })
    : null;
const MODEL_ID = process.env.MODEL_ID || process.env.OPENAI_MODEL || 'gpt-5';
const TEMPERATURE = typeof process.env.TEMPERATURE !== 'undefined' ? Number(process.env.TEMPERATURE) : 0.1;
const MAX_TOKENS = typeof process.env.MAX_TOKENS !== 'undefined' ? Number(process.env.MAX_TOKENS) : null;
// Increase internal HTTP timeout for long-running local API calls used during summarization
const INTERNAL_API_TIMEOUT_MS = Number(process.env.INTERNAL_API_TIMEOUT_MS || 1500000);
// Conservative timeout for internal calls made by light endpoints (e.g., classification)
const CLASSIFY_INTERNAL_TIMEOUT_MS = Number(process.env.CLASSIFY_INTERNAL_TIMEOUT_MS || 60000);
// Max time the summarization SSE should be allowed to run (25 minutes default)
const SUMMARIZE_TIMEOUT_MS = Number(process.env.SUMMARIZE_TIMEOUT_MS || 1500000);
// Warmup configuration
const WARM_ALL_ON_START = String(process.env.WARM_ALL_ON_START || '').toLowerCase() === 'true';
const WARM_CONCURRENCY = Math.max(1, Number(process.env.WARM_CONCURRENCY || 2));
const WARM_MAX_HEARINGS = Number(process.env.WARM_MAX_HEARINGS || 0); // 0 = no limit
const WARM_RETRY_ATTEMPTS = Math.max(1, Number(process.env.WARM_RETRY_ATTEMPTS || 2));
// Background mode default
function parseBoolean(value) {
    const v = String(value || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}
const OPENAI_BACKGROUND_DEFAULT = parseBoolean(process.env.OPENAI_BACKGROUND || process.env.BACKGROUND_MODE || process.env['BACKGROUND-MODE'] || 'false');
const BACKGROUND_MODE = parseBoolean(process.env.BACKGROUND_MODE || 'true');

// Verbosity and reasoning effort controls (opt-in via env)
function normalizeVerbosity(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (['low', 'minimal', 'min'].includes(v)) return 'low';
    if (['medium', 'med', 'normal', 'default'].includes(v)) return 'medium';
    if (['high', 'verbose', 'max'].includes(v)) return 'high';
    if (v === 'none' || v === 'off' || v === 'false') return null;
    return v; // pass-through for future values like 'auto'
}
function normalizeReasoningEffort(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (['minimal', 'low', 'min'].includes(v)) return 'low';
    if (['medium', 'med', 'normal', 'default'].includes(v)) return 'medium';
    if (['high', 'max'].includes(v)) return 'high';
    if (v === 'none' || v === 'off' || v === 'false') return null;
    return v;
}
const VERBOSITY_ENV = normalizeVerbosity(process.env.OPENAI_VERBOSITY || process.env.VERBOSITY || 'high');
const REASONING_EFFORT_ENV = normalizeReasoningEffort(process.env.OPENAI_REASONING_EFFORT || process.env.REASONING_EFFORT || 'high');

function resolvePromptPath() {
    if (process.env.SUMMARY_PROMPT_PATH) return process.env.SUMMARY_PROMPT_PATH;
    const candidate1 = path.join(__dirname, 'prompts', 'prompt.md');
    if (fs.existsSync(candidate1)) return candidate1;
    return path.join(__dirname, 'prompts', 'prompt.md');
}

function resolveClassifierPromptPath() {
    if (process.env.CLASSIFIER_PROMPT_PATH) return process.env.CLASSIFIER_PROMPT_PATH;
    const candidate = path.join(__dirname, 'prompts', 'auto-classify-respondents.md');
    if (fs.existsSync(candidate)) return candidate;
    return candidate;
}
function resolveTemplatePath() {
    if (process.env.DOCX_TEMPLATE_PATH) return process.env.DOCX_TEMPLATE_PATH;
    const templatesDir = path.join(__dirname, 'templates');
    try {
        if (fs.existsSync(templatesDir)) {
            const firstDocx = (fs.readdirSync(templatesDir).find(f => f.toLowerCase().endsWith('.docx')));
            if (firstDocx) return path.join(templatesDir, firstDocx);
        }
    } catch {}
    // Legacy fallback
    const legacyDir = path.join(__dirname, 'scriptskabelon');
    try {
        if (fs.existsSync(legacyDir)) {
            const firstDocx = (fs.readdirSync(legacyDir).find(f => f.toLowerCase().endsWith('.docx')));
            if (firstDocx) return path.join(legacyDir, firstDocx);
        }
    } catch {}
    return path.join(__dirname, 'templates', 'template.docx');
}
const PROMPT_PATH = resolvePromptPath();
const CLASSIFIER_PROMPT_PATH = resolveClassifierPromptPath();
const TEMPLATE_DOCX = resolveTemplatePath();

const LOG_FILE = path.join(__dirname, 'server.log');
function logDebug(message) {
    try {
        const line = `[${new Date().toISOString()}] ${String(message || '')}`;
        try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (_) {}
        try { console.log(line); } catch (_) {}
    } catch (_) {}
}

// Compute fast pre-thought headings from input to show immediate reasoning summary
function computePreThoughts(inputText) {
    const lc = String(inputText || '').toLowerCase();
    const buckets = [
        { key: 'trafik', label: 'Trafik og parkering', re: /trafik|parkering|bil|bus|kørsel|koersel|krydset|vej|ve[jy]/g },
        { key: 'stoej', label: 'Støj og boldbane', re: /støj|stoej|boldbur|boldbane|støjværn|stoejvaern|larm/g },
        { key: 'skole', label: 'Skole og institution', re: /skole|institution|daginstitution|børnehave|boernehave|vuggestue/g },
        { key: 'klima', label: 'Klima og grønne områder', re: /klima|grøn|groen|groent|biodivers|regnvand|træ|trae|grønt/g },
        { key: 'byg', label: 'Byggehøjde og skygge', re: /højde|hoejde|skygge|etage|høj|hoej|kollegium/g },
        { key: 'cykel', label: 'Cykel og mobilitet', re: /cykel|cykelsti|fortov|gående|gaaende|mobilitet/g },
        { key: 'tryg', label: 'Tryghed og sikkerhed', re: /tryghed|sikkerhed/g },
        { key: 'proces', label: 'Proces og inddragelse', re: /borgermøde|borgermoede|høring|hoering|proces/g }
    ];
    const scored = [];
    for (const b of buckets) {
        const m = lc.match(b.re);
        if (m && m.length) scored.push({ label: b.label, n: m.length });
    }
    scored.sort((a, b) => b.n - a.n);
    return scored.slice(0, 6).map(s => s.label);
}

const app = express();
const PORT = process.env.PORT || 3010;

// Behind Render's proxy so req.secure reflects X-Forwarded-Proto
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
try { app.set('trust proxy', 1); } catch {}

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: path.join(__dirname, 'uploads') });
try { fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true }); } catch {}
// Ensure templates dir exists for DOCX builder (python script writes template if missing)
try { fs.mkdirSync(path.join(__dirname, 'templates'), { recursive: true }); } catch {}
// Ensure persistent data dir exists BEFORE session + DB init
try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch {}

// Initialize SQLite and sessions
try { initDb(); } catch (e) { console.error('SQLite init failed:', e.message); }
app.use(session({
    store: new SQLiteStore({ db: (process.env.SESSION_DB || 'sessions.sqlite'), dir: path.join(__dirname, 'data') }),
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: Number(process.env.SESSION_MAX_AGE_MS || 1000*60*60*24*7),
        secure: isProduction,
        sameSite: 'lax'
    }
}));

// Reuse TCP connections for speed
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.httpAgent = keepAliveHttpAgent;
axios.defaults.httpsAgent = keepAliveHttpsAgent;
axios.defaults.timeout = 30000;

// Lightweight in-memory caches (TTL-based) to avoid refetching same hearing repeatedly
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000); // 2 minutes default
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 100);

const hearingAggregateCache = new Map(); // key: hearingId -> { value, expiresAt }
const hearingResponsesCache = new Map(); // key: hearingId -> { value, expiresAt }
const hearingMaterialsCache = new Map(); // key: hearingId -> { value, expiresAt }

// Optional persistent disk cache to speed up mock/demo and reduce repeated network traffic
const PERSIST_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(path.join(PERSIST_DIR, 'hearings'), { recursive: true }); } catch {}
const PERSIST_PREFER = String(process.env.PERSIST_PREFER || '').toLowerCase() === 'true';
const PERSIST_ALWAYS_WRITE = String(process.env.PERSIST_ALWAYS_WRITE || 'true').toLowerCase() !== 'false';
const PERSIST_MAX_AGE_MS = Number(process.env.PERSIST_MAX_AGE_MS || 0); // 0 disables TTL (never stale)

function getPersistPathForHearing(hearingId) {
    return path.join(PERSIST_DIR, 'hearings', `${hearingId}.json`);
}
function readPersistedHearing(hearingId) {
    try {
        const p = getPersistPathForHearing(hearingId);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        return json && typeof json === 'object' ? json : null;
    } catch {
        return null;
    }
}
function writePersistedHearing(hearingId, payload) {
    try {
        const p = getPersistPathForHearing(hearingId);
        const toWrite = { updatedAt: new Date().toISOString(), ...payload };
        fs.writeFileSync(p, JSON.stringify(toWrite, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}
function mergePersistMaterials(existing, materials) {
    if (!materials || !Array.isArray(materials)) return existing || null;
    const base = existing && typeof existing === 'object' ? existing : {};
    const out = { ...base };
    out.materials = materials;
    return out;
}

function readPersistedHearingWithMeta(hearingId) {
    try {
        const p = getPersistPathForHearing(hearingId);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        const updatedAt = (json && json.updatedAt) ? Date.parse(json.updatedAt) : null;
        const stat = fs.statSync(p);
        const updatedAtMs = Number.isFinite(updatedAt) ? updatedAt : stat.mtimeMs;
        return { data: json, updatedAtMs };
    } catch {
        return null;
    }
}

function isPersistStale(meta) {
    try {
        if (!meta || typeof meta.updatedAtMs !== 'number') return true;
        if (!Number.isFinite(PERSIST_MAX_AGE_MS) || PERSIST_MAX_AGE_MS <= 0) return false; // TTL disabled
        return (Date.now() - meta.updatedAtMs) > PERSIST_MAX_AGE_MS;
    } catch { return false; }
}

function mergeResponsesPreferLongerText(a, b) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    if (arrA.length === 0) return arrB;
    if (arrB.length === 0) return arrA;
    if (arrA.length > arrB.length) return arrA;
    if (arrB.length > arrA.length) return arrB;
    // Same count: merge by id, prefer longer text and union attachments
    const byId = new Map();
    for (const r of arrA) byId.set(Number(r.id || r.responseNumber), r);
    for (const r of arrB) {
        const id = Number(r.id || r.responseNumber);
        const ex = byId.get(id);
        if (!ex) { byId.set(id, r); continue; }
        const exLen = (ex.text || '').length;
        const rLen = (r.text || '').length;
        const winner = rLen > exLen ? r : ex;
        // merge attachments
        const attA = Array.isArray(ex.attachments) ? ex.attachments : [];
        const attB = Array.isArray(r.attachments) ? r.attachments : [];
        const seen = new Set();
        const mergedAtts = [];
        for (const aItem of [...attA, ...attB]) {
            const key = `${aItem.filename || ''}|${aItem.url || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            mergedAtts.push(aItem);
        }
        byId.set(id, { ...winner, attachments: mergedAtts });
    }
    return Array.from(byId.values()).sort((x, y) => (x.id || 0) - (y.id || 0));
}

function mergePersistPayload(existing, incoming) {
    const base = existing && typeof existing === 'object' ? existing : {};
    const inc = incoming && typeof incoming === 'object' ? incoming : {};
    const out = { ...base, ...inc };
    // Merge hearing meta conservatively
    out.hearing = { ...(base.hearing || {}), ...(inc.hearing || {}) };
    // Best responses
    out.responses = mergeResponsesPreferLongerText(base.responses, inc.responses);
    out.totalResponses = Array.isArray(out.responses) ? out.responses.length : (inc.totalResponses || base.totalResponses || 0);
    // Best totalPages (max)
    out.totalPages = Math.max(Number(base.totalPages || 0), Number(inc.totalPages || 0)) || undefined;
    // Materials: prefer the incoming if present
    if (!Array.isArray(inc.materials) || inc.materials.length === 0) out.materials = base.materials || [];
    // Always success if either was successful
    out.success = (base.success || inc.success) ? true : false;
    return out;
}

// =============================
// Background Jobs Service (SQLite-backed + in-memory)
// =============================

const DEFAULT_VARIANTS = Number(process.env.DEFAULT_SUMMARY_VARIANTS || 1);
const JOB_RECOMMENDED_POLL_MS = Number(process.env.JOB_RECOMMENDED_POLL_MS || 3000);
const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 5000);
const SESSION_JOB_LIMIT = Number(process.env.SESSION_JOB_LIMIT || 2);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 72*60*60*1000);

const activeJobControllers = new Map(); // jobId -> { cancelled: boolean }
const jobEventsCache = new Map(); // jobId -> ring buffer (array) of recent events
const jobSessionIndex = new Map(); // jobId -> sessionKey
const sessionActiveJobs = new Map(); // sessionKey -> count

function getSessionKey(req) {
    try {
        const sid = req?.sessionID || req?.session?.id;
        if (sid) return `sid:${sid}`;
    } catch {}
    try {
        const ip = (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown').toString();
        return `ip:${ip}`;
    } catch {}
    return 'ip:unknown';
}

function stableStringify(obj) {
    const seen = new WeakSet();
    function sortValue(v) {
        if (v && typeof v === 'object') {
            if (seen.has(v)) return null;
            seen.add(v);
            if (Array.isArray(v)) return v.map(sortValue);
            const out = {};
            Object.keys(v).sort().forEach(k => { out[k] = sortValue(v[k]); });
            return out;
        }
        return v;
    }
    try { return JSON.stringify(sortValue(obj)); } catch { return JSON.stringify({}); }
}

function sha1Hex(s) {
    try { return crypto.createHash('sha1').update(String(s||''), 'utf8').digest('hex'); } catch { return null; }
}

function nowMs() { return Date.now(); }

function recordSessionJobStart(req, jobId) {
    const key = getSessionKey(req);
    jobSessionIndex.set(jobId, key);
    const n = sessionActiveJobs.get(key) || 0;
    sessionActiveJobs.set(key, n + 1);
}

function recordSessionJobEnd(jobId) {
    const key = jobSessionIndex.get(jobId);
    if (!key) return;
    const n = sessionActiveJobs.get(key) || 0;
    sessionActiveJobs.set(key, Math.max(0, n - 1));
    jobSessionIndex.delete(jobId);
}

function canStartAnotherJob(req) {
    const key = getSessionKey(req);
    const n = sessionActiveJobs.get(key) || 0;
    return n < SESSION_JOB_LIMIT;
}

function appendEvent(jobId, level, message, data) {
    try {
        const ts = nowMs();
        sqliteDb && sqliteDb.prepare && sqliteDb.prepare(`INSERT INTO job_events(job_id, ts, level, message, data_json) VALUES (?,?,?,?,?)`) 
            .run(jobId, ts, level || 'info', String(message || ''), data ? JSON.stringify(data) : null);
    } catch {}
    try {
        const arr = jobEventsCache.get(jobId) || [];
        arr.push({ ts: nowMs(), level: level || 'info', message: String(message||''), data: data || null });
        while (arr.length > 50) arr.shift();
        jobEventsCache.set(jobId, arr);
    } catch {}
    try { console.log(`[job:${jobId}] ${level||'info'}: ${message}`); } catch {}
}

function updateJob(jobId, patch) {
    try {
        const now = nowMs();
        const keys = ['state','phase','progress'];
        const cur = sqliteDb.prepare(`SELECT state,phase,progress FROM jobs WHERE job_id=?`).get(jobId) || {};
        const next = { ...cur, ...patch };
        sqliteDb.prepare(`UPDATE jobs SET state=?, phase=?, progress=?, updated_at=? WHERE job_id=?`) 
            .run(next.state || null, next.phase || null, Number.isFinite(next.progress) ? next.progress : cur.progress || 0, now, jobId);
    } catch (e) { /* ignore */ }
}

function updateVariant(jobId, variant, patch) {
    try {
        const now = nowMs();
        const cur = sqliteDb.prepare(`SELECT state,phase,progress,response_id,markdown,summary,headings_json,partial_chars,error FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, variant) || {};
        const next = { ...cur, ...patch };
        sqliteDb.prepare(`UPDATE job_variants SET state=?, phase=?, progress=?, response_id=?, markdown=?, summary=?, headings_json=?, partial_chars=?, error=?, updated_at=? WHERE job_id=? AND variant=?`)
            .run(next.state || null, next.phase || null, Number.isFinite(next.progress) ? next.progress : (cur.progress || 0), next.response_id || cur.response_id || null, next.markdown || cur.markdown || null, next.summary || cur.summary || null, next.headings_json || cur.headings_json || null, Number.isFinite(next.partial_chars) ? next.partial_chars : (cur.partial_chars || 0), next.error || cur.error || null, now, jobId, variant);
    } catch {}
}

function getJobSnapshot(jobId) {
    try {
        const job = sqliteDb.prepare(`SELECT job_id, hearing_id, state, phase, progress, created_at, updated_at FROM jobs WHERE job_id=?`).get(jobId);
        if (!job) return null;
        const vars = sqliteDb.prepare(`SELECT variant as id, state, phase, progress, response_id as responseId, markdown, summary, headings_json as headingsJson, partial_chars as partialChars, error FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(jobId);
        const variants = vars.map(v => ({ id: v.id, state: v.state, phase: v.phase, progress: v.progress || 0, responseId: v.responseId || null, done: v.state === 'completed', error: v.error || null, partialChars: v.partialChars || 0, hasResult: !!(v.markdown && v.markdown.length) }));
        let errors = [];
        try {
            const ev = sqliteDb.prepare(`SELECT message FROM job_events WHERE job_id=? AND level='error' ORDER BY ts DESC LIMIT 5`).all(jobId);
            errors = (ev||[]).map(e => ({ message: e.message }));
        } catch {}
        return {
            jobId: job.job_id,
            hearingId: job.hearing_id,
            state: job.state,
            phase: job.phase,
            progress: job.progress || 0,
            variants,
            errors: errors.length ? errors : undefined,
            createdAt: job.created_at,
            updatedAt: job.updated_at
        };
    } catch {
        return null;
    }
}

async function createJob(req, hearingId, payload) {
    const n = Math.max(1, Math.min(Number(req.query.n || (payload && payload.n) || DEFAULT_VARIANTS) || DEFAULT_VARIANTS, 5));
    if (!canStartAnotherJob(req)) {
        return { error: 'Too many concurrent jobs', status: 429 };
    }
    const idemp = req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || null;
    const input = { hearingId, n, hearing: payload?.hearing || null, responses: payload?.responses || null, materials: payload?.materials || null, edits: payload?.edits || null };
    const inputHash = sha1Hex(stableStringify(input));

    try {
        if (idemp) {
            const existing = sqliteDb.prepare(`SELECT job_id, input_hash FROM jobs WHERE idempotency_key=?`).get(idemp);
            if (existing) {
                if (existing.input_hash === inputHash) {
                    appendEvent(existing.job_id, 'info', 'Idempotent reuse of existing job');
                    return { jobId: existing.job_id, reused: true };
                }
                return { error: 'Idempotency key already used for different input', status: 409 };
            }
        }
    } catch {}

    const jobId = `job_${crypto.randomUUID ? crypto.randomUUID() : sha1Hex(String(Math.random()))}`;
    const now = nowMs();
    try {
        sqliteDb.prepare(`INSERT INTO jobs(job_id, hearing_id, state, phase, progress, created_at, updated_at, idempotency_key, input_hash) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(jobId, Number(hearingId), 'queued', 'queued', 0, now, now, idemp || null, inputHash || null);
        const insVar = sqliteDb.prepare(`INSERT INTO job_variants(job_id, variant, state, phase, progress, updated_at) VALUES (?,?,?,?,?,?)`);
        for (let i = 1; i <= n; i++) insVar.run(jobId, i, 'queued', 'queued', 0, now);
    } catch (e) {
        return { error: 'DB insert failed', status: 500 };
    }

    appendEvent(jobId, 'info', 'Job created', { hearingId, n });
    activeJobControllers.set(jobId, { cancelled: false });
    recordSessionJobStart(req, jobId);
    // Fire-and-forget runner
    runJob(jobId, hearingId, input).catch(err => {
        appendEvent(jobId, 'error', `Runner crashed: ${err?.message || err}`);
        updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
        recordSessionJobEnd(jobId);
    });
    return { jobId };
}

function getModelParams(userPrompt, systemPrompt) {
    const model = MODEL_ID;
    const params = {
        model,
        input: [
            { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
            { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
        ]
    };
    const isReasoningModel = /^(gpt-5|o3|o4)/i.test(model);
    if (!isReasoningModel && Number.isFinite(TEMPERATURE)) params.temperature = TEMPERATURE;
    if (Number.isFinite(MAX_TOKENS) && MAX_TOKENS > 0) params.max_output_tokens = MAX_TOKENS;
    if (/^gpt-5/i.test(model) && VERBOSITY_ENV) params.text = { ...(params.text || {}), verbosity: VERBOSITY_ENV };
    if ((/^(gpt-5|o3|o4)/i).test(model) && REASONING_EFFORT_ENV) params.reasoning = { ...(params.reasoning || {}), effort: REASONING_EFFORT_ENV };
    return params;
}

function extractHeadingsFromMarkdown(md) {
    try { return (String(md||'').match(/^#{1,6} .*$/mg) || []).map(h => h.replace(/^#{1,6}\s*/, '')).slice(0, 50); } catch { return []; }
}

function parseOpenAIText(resp) {
    let text = '';
    try {
        if (!resp) return '';
        if (typeof resp.output_text === 'string') text = resp.output_text;
        else if (Array.isArray(resp.output_text)) text = resp.output_text.join('\n');
        else if (Array.isArray(resp.output)) {
            text = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n');
        }
    } catch {}
    return (text || '').trim();
}

async function buildPromptFromInput(hearingId, input) {
    // Try to use provided hearing/responses/materials; else fetch aggregated data
    let hearing = input?.hearing || null;
    let responses = Array.isArray(input?.responses) ? input.responses : null;
    let materials = Array.isArray(input?.materials) ? input.materials : null;
    const base = `http://localhost:${PORT}`;
    if (!hearing || !responses || !materials) {
        try {
            const r = await axios.get(`${(process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`}/api/hearing/${hearingId}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
            if (r && r.data && r.data.success) {
                hearing = hearing || r.data.hearing;
                responses = responses || r.data.responses || [];
                materials = materials || r.data.materials || [];
            }
        } catch {}
    }
    // Apply minimal respondent overrides if provided
    try {
        const overrides = input?.edits && typeof input.edits === 'object' ? input.edits : null;
        if (overrides && Array.isArray(responses)) {
            responses = responses.map(r => {
                const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                if (!ov || typeof ov !== 'object') return r;
                const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                const patched = { ...r };
                if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                return patched;
            });
        }
    } catch {}

    const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
    const RESP_LIMIT = Number(process.env.RESP_CHAR_LIMIT || 200000);
    const MAT_LIMIT = Number(process.env.MAT_CHAR_LIMIT || 120000);
    const repliesParts = ['# Samlede Høringssvar'];
    for (const r of (responses||[])) {
        repliesParts.push(`## Svar ${r.id}`);
        const prefName = r.respondentnavn || r.respondentName;
        const who = [prefName || r.author, r.organization && r.organization !== (prefName || r.author) ? r.organization : null].filter(Boolean).join(' ');
        if (who || r.submittedAt) {
            const parts = [];
            if (who) parts.push(who);
            if (r.submittedAt) parts.push(new Date(r.submittedAt).toISOString());
            repliesParts.push(`- ${parts.join(' • ')}`);
        }
        repliesParts.push('');
        repliesParts.push(r.text || '');
        repliesParts.push('');
    }
    const repliesMd = repliesParts.join('\n');
    const materialParts = [`# Høringsmateriale for ${(hearing && hearing.title) || ''}`];
    for (const m of (materials||[])) {
        const kind = m.kind || m.type;
        if ((kind === 'description' || kind === 'text') && m.content) {
            materialParts.push('');
            materialParts.push(String(m.content));
            materialParts.push('');
        } else if (kind === 'file' && m.url) {
            materialParts.push(`- ${m.title || 'Dokument'}: ${m.url}`);
        } else if (m.url && !kind) {
            materialParts.push(`- ${m.title || 'Dokument'}: ${m.url}`);
        }
    }
    const materialMd = materialParts.join('\n');
    const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
    const userPrompt = `${promptTemplate}\n\n# Samlede Høringssvar\n\n${repliesMd.slice(0, RESP_LIMIT)}\n\n# Høringsmateriale \n\n${materialMd.slice(0, MAT_LIMIT)}`;
    return { hearing, responses, materials, systemPrompt, userPrompt };
}

async function runJob(jobId, hearingId, input) {
    try {
        updateJob(jobId, { state: 'preparing', phase: 'preparing', progress: 10 });
        appendEvent(jobId, 'info', 'Preparing input');
        if (!openai) {
            appendEvent(jobId, 'error', 'OPENAI_API_KEY is missing');
            updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
            recordSessionJobEnd(jobId);
            return;
        }

        const built = await buildPromptFromInput(hearingId, input || {});
        updateJob(jobId, { state: 'creating-job', phase: 'creating-job', progress: 20 });
        appendEvent(jobId, 'info', 'Creating background variants');

        // Determine number of variants from DB rows
        const rows = sqliteDb.prepare(`SELECT variant FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(jobId);
        const variantIds = rows.map(r => r.variant);

        const createPromises = [];
        for (const v of variantIds) {
            createPromises.push((async () => {
                try {
                    updateVariant(jobId, v, { state: 'creating-job', phase: 'creating-job', progress: 20 });
                    const params = getModelParams(built.userPrompt, built.systemPrompt);
                    const created = await openai.responses.create({ ...params, stream: false, background: true });
                    const responseId = created && (created.id || created.response_id || created.response?.id);
                    if (!responseId) throw new Error('No response_id from OpenAI');
                    updateVariant(jobId, v, { state: 'polling', phase: 'polling', progress: 30, response_id: responseId });
                    appendEvent(jobId, 'info', `Variant ${v} queued`, { responseId });
                } catch (e) {
                    const msg = e?.response?.data?.error?.message || e?.message || String(e);
                    updateVariant(jobId, v, { state: 'failed', phase: 'failed', progress: 100, error: msg });
                    appendEvent(jobId, 'error', `Variant ${v} failed to create`, { error: msg });
                }
            })());
        }

        await Promise.all(createPromises);

        updateJob(jobId, { state: 'polling', phase: 'polling', progress: 40 });
        appendEvent(jobId, 'info', 'Polling background jobs');

        const maxPolls = Number.isFinite(SUMMARIZE_TIMEOUT_MS) ? Math.ceil(SUMMARIZE_TIMEOUT_MS / JOB_POLL_INTERVAL_MS) : 300;
        for (let t = 0; t < maxPolls; t++) {
            const ctrl = activeJobControllers.get(jobId);
            if (ctrl && ctrl.cancelled) {
                appendEvent(jobId, 'warn', 'Job cancelled');
                updateJob(jobId, { state: 'cancelled', phase: 'cancelled', progress: 100 });
                recordSessionJobEnd(jobId);
                return;
            }

            const variants = sqliteDb.prepare(`SELECT variant, state, response_id FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(jobId);
            let allDone = true;
            for (const v of variants) {
                if (!v.response_id) { allDone = false; continue; }
                if (v.state === 'completed' || v.state === 'failed' || v.state === 'cancelled') continue;
                allDone = false;
                try {
                    const r = await openai.responses.retrieve(v.response_id);
                    const status = (r && (r.status || r.state || r.response?.status)) || '';
                    if (status && /failed/i.test(status)) {
                        updateVariant(jobId, v.variant, { state: 'failed', phase: 'failed', progress: 100, error: r?.error?.message || status });
                        appendEvent(jobId, 'error', `Variant ${v.variant} failed`, { status });
                    } else if (status && /completed|succeeded|done/i.test(status)) {
                        // Retrieve final output
                        let text = parseOpenAIText(r);
                        if (!text) {
                            try {
                                const stream = await openai.responses.stream({ response_id: v.response_id });
                                let acc = '';
                                for await (const ev of stream) {
                                    if (ev?.type === 'response.output_text.delta') acc += (ev.delta || '');
                                }
                                text = acc || text;
                            } catch {}
                        }
                        const headings = extractHeadingsFromMarkdown(text);
                        updateVariant(jobId, v.variant, { state: 'completed', phase: 'completed', progress: 100, markdown: text, summary: null, headings_json: JSON.stringify(headings||[]), partial_chars: (text||'').length });
                        appendEvent(jobId, 'info', `Variant ${v.variant} completed`, { chars: (text||'').length });
                    } else {
                        // still running
                        const prog = 30 + Math.min(60, Math.round((t / maxPolls) * 30));
                        updateVariant(jobId, v.variant, { state: 'running', phase: 'running', progress: prog });
                    }
                } catch (e) {
                    const msg = e?.message || 'poll error';
                    appendEvent(jobId, 'warn', `Poll error for variant ${v.variant}`, { error: msg });
                }
            }

            // Update aggregate job progress
            try {
                const agg = sqliteDb.prepare(`SELECT AVG(progress) as p FROM job_variants WHERE job_id=?`).get(jobId);
                const p = Math.max(0, Math.min(100, Math.round(agg?.p || 0)));
                updateJob(jobId, { state: allDone ? 'running' : 'polling', phase: allDone ? 'running' : 'polling', progress: p });
            } catch {}

            if (allDone) break;
            await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS));
        }

        // Finalize job state
        const remain = sqliteDb.prepare(`SELECT COUNT(*) as n FROM job_variants WHERE job_id=? AND state NOT IN ('completed','failed','cancelled')`).get(jobId).n;
        const anyFailed = sqliteDb.prepare(`SELECT COUNT(*) as n FROM job_variants WHERE job_id=? AND state='failed'`).get(jobId).n > 0;
        if (remain === 0) {
            updateJob(jobId, { state: anyFailed ? 'failed' : 'completed', phase: anyFailed ? 'failed' : 'completed', progress: 100 });
        } else {
            updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
        }
        recordSessionJobEnd(jobId);
    } catch (e) {
        appendEvent(jobId, 'error', `Unhandled runner error: ${e?.message || e}`);
        updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
        recordSessionJobEnd(jobId);
    }
}

function cancelJob(jobId) {
    const ctrl = activeJobControllers.get(jobId);
    if (ctrl) ctrl.cancelled = true;
    updateJob(jobId, { state: 'cancelled', phase: 'cancelled', progress: 100 });
    appendEvent(jobId, 'warn', 'Job cancelled by client');
}

function resumeDanglingJobs() {
    try {
        const rows = sqliteDb.prepare(`SELECT job_id, hearing_id FROM jobs WHERE state IN ('queued','preparing','creating-job','polling','running')`).all();
        for (const r of rows) {
            if (activeJobControllers.has(r.job_id)) continue;
            activeJobControllers.set(r.job_id, { cancelled: false });
            runJob(r.job_id, r.hearing_id, null).catch(e => {
                appendEvent(r.job_id, 'error', `Resume failed: ${e?.message || e}`);
                updateJob(r.job_id, { state: 'failed', phase: 'failed', progress: 100 });
            });
        }
    } catch {}
}

// Cleanup cron: delete old jobs and related rows
function cleanupOldJobs() {
    try {
        const cutoff = nowMs() - JOB_TTL_MS;
        const olds = sqliteDb.prepare(`SELECT job_id FROM jobs WHERE updated_at < ?`).all(cutoff);
        const delVar = sqliteDb.prepare(`DELETE FROM job_variants WHERE job_id=?`);
        const delEvt = sqliteDb.prepare(`DELETE FROM job_events WHERE job_id=?`);
        const delJob = sqliteDb.prepare(`DELETE FROM jobs WHERE job_id=?`);
        for (const j of olds) {
            delVar.run(j.job_id); delEvt.run(j.job_id); delJob.run(j.job_id);
            jobEventsCache.delete(j.job_id);
            activeJobControllers.delete(j.job_id);
        }
    } catch {}
}

async function legacySummarizeAsJobSse(req, res, payload) {
    const sendEvent = (name, data) => { try { if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
    try {
        const hearingId = String(req.params.id).trim();
        const n = Math.max(1, Math.min(Number(req.query.n || (payload && payload.n) || DEFAULT_VARIANTS) || DEFAULT_VARIANTS, 5));
        let edits = null;
        try { edits = payload && payload.edits ? payload.edits : (req.query && req.query.edits ? JSON.parse(String(req.query.edits)) : null); } catch { edits = null; }
        const input = {
            hearing: payload && payload.hearing || null,
            responses: payload && payload.responses || null,
            materials: payload && payload.materials || null,
            edits,
            n
        };
        const out = await createJob(req, hearingId, input);
        if (out.error) { sendEvent('error', { message: out.error }); try { res.end(); } catch {}; return; }
        const jobId = out.jobId;
        sendEvent('info', { message: 'Baggrundsjob oprettet', jobId });
        for (let i = 1; i <= n; i++) { sendEvent('placeholder', { id: i }); sendEvent('status', { id: i, phase: 'queued', message: 'I kø…' }); }
        const sent = new Set();
        const statusCache = new Map();
        const pollMs = Math.max(2000, JOB_RECOMMENDED_POLL_MS);
        const start = Date.now();
        while (!res.writableEnded && Date.now() - start < SUMMARIZE_TIMEOUT_MS) {
            const snap = getJobSnapshot(jobId);
            if (!snap) { sendEvent('status', { phase: 'polling', message: 'Afventer job…' }); await new Promise(r => setTimeout(r, pollMs)); continue; }
            // Aggregate progress/status
            sendEvent('info', { message: `Status: ${snap.state}`, progress: snap.progress });
            for (const v of (snap.variants || [])) {
                const key = `${v.id}`;
                const prev = statusCache.get(key) || {};
                if (prev.state !== v.state || prev.progress !== v.progress || prev.phase !== v.phase) {
                    statusCache.set(key, { state: v.state, progress: v.progress, phase: v.phase });
                    sendEvent('status', { id: v.id, phase: v.phase || v.state, message: (v.state || '').toString(), progress: v.progress || 0 });
                }
                if (v.done && !sent.has(v.id)) {
                    try {
                        const row = sqliteDb.prepare(`SELECT markdown, summary, headings_json FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, v.id);
                        const headings = row && row.headings_json ? JSON.parse(row.headings_json) : [];
                        sendEvent('variant', { variant: { id: v.id, markdown: row?.markdown || '', summary: row?.summary || '', headings } });
                        sent.add(v.id);
                    } catch {}
                }
            }
            if (snap.state === 'completed') { sendEvent('end', { message: 'Færdig' }); break; }
            if (snap.state === 'failed') { sendEvent('error', { message: 'Job fejlede' }); break; }
            if (snap.state === 'cancelled') { sendEvent('error', { message: 'Job annulleret' }); break; }
            await new Promise(r => setTimeout(r, pollMs));
        }
    } catch (e) {
        sendEvent('error', { message: e?.message || 'Ukendt fejl' });
    } finally {
        try { res.end(); } catch {}
    }
}

// API: Create summarize job
app.post('/api/jobs/summarize/:hearingId', express.json({ limit: '25mb' }), async (req, res) => {
    try {
        const hearingId = String(req.params.hearingId).trim();
        const payload = {
            hearing: req.body?.hearing,
            responses: req.body?.responses,
            materials: req.body?.materials,
            edits: req.body?.edits,
            n: req.body?.n
        };
        const out = await createJob(req, hearingId, payload);
        if (out.error) return res.status(out.status || 400).json({ success: false, message: out.error });
        return res.status(202).json({ success: true, jobId: out.jobId, recommendedPoll: JOB_RECOMMENDED_POLL_MS });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// API: Job status
app.get('/api/jobs/:jobId', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const snap = getJobSnapshot(jobId);
    if (!snap) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, ...snap });
});

// API: Variant result
app.get('/api/jobs/:jobId/variant/:n', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const n = Number(req.params.n);
    try {
        const row = sqliteDb.prepare(`SELECT markdown, summary, headings_json as headingsJson, state FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, n);
        if (!row) return res.status(404).json({ success: false, message: 'Variant not found' });
        const payload = {
            id: n,
            state: row.state || null,
            markdown: row.markdown || null,
            summary: row.summary || null,
            headings: row.headingsJson ? JSON.parse(row.headingsJson) : []
        };
        res.json({ success: true, ...payload });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Cancel job
app.delete('/api/jobs/:jobId', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const snap = getJobSnapshot(jobId);
    if (!snap) return res.status(404).json({ success: false, message: 'Job not found' });
    cancelJob(jobId);
    res.json({ success: true });
});

function cacheGet(map, key) {
    const entry = map.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    if (entry) map.delete(key);
    return null;
}
function cacheSet(map, key, value, ttlMs = CACHE_TTL_MS) {
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (map.size > CACHE_MAX_ENTRIES * 1.2) {
        // Simple FIFO prune
        const removeCount = map.size - CACHE_MAX_ENTRIES;
        for (let i = 0; i < removeCount; i += 1) {
            const firstKey = map.keys().next().value;
            if (typeof firstKey === 'undefined') break;
            map.delete(firstKey);
        }
    }
}

// Quiet 404 noise for favicon in dev
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// In-memory hearing index for search
const CACHE_FILE = path.join(__dirname, 'hearings-cache.json');
let hearingIndex = [];

// Helpers to read local assets
function readTextFileSafe(filePath) {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetries(fn, { attempts = 3, baseDelayMs = 400, onError } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i += 1) {
        try { return await fn(i); }
        catch (e) {
            lastErr = e;
            if (onError) {
                try { onError(e, i); } catch {}
            }
            if (i < attempts) {
                // Exponential-ish backoff with small jitter
                const jitter = Math.floor(Math.random() * 100);
                await sleep(baseDelayMs * i + jitter);
            }
        }
    }
    throw lastErr;
}

async function extractTextFromLocalFile(filePath) {
    try {
        const ext = String(path.extname(filePath) || '').toLowerCase();
        if (ext === '.pdf') {
            const pdfParse = require('pdf-parse');
            const buf = fs.readFileSync(filePath);
            const parsed = await pdfParse(buf);
            return String(parsed.text || '');
        }
        if (ext === '.docx') {
            const python = process.env.PYTHON_BIN || 'python3';
            const script = `import sys\nfrom docx import Document\np=Document(sys.argv[1])\nprint('\n'.join([p2.text for p2 in p.paragraphs]))`;
            const tmpPy = path.join(ensureTmpDir(), `read_${Date.now()}.py`);
            fs.writeFileSync(tmpPy, script, 'utf8');
            const txt = await new Promise((resolve, reject) => {
                const c = spawn(python, [tmpPy, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '', err = '';
                c.stdout.on('data', d => out += d.toString());
                c.stderr.on('data', d => err += d.toString());
                c.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
            }).catch(() => '');
            return String(txt || '');
        }
        if (ext === '.txt' || ext === '.md') {
            return fs.readFileSync(filePath, 'utf8');
        }
        // Unsupported types: return empty; we'll still include size-based token note elsewhere
        return '';
    } catch {
        return '';
    }
}

function ensureTmpDir() {
    const dir = path.join(__dirname, 'tmp');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
}

// Danish-aware normalization (case, punctuation, diacritics, and special letters)
function normalizeDanish(input) {
    if (typeof input !== 'string') return '';
    const lowered = input.toLowerCase();
    const map = {
        'æ': 'ae', 'ø': 'o', 'å': 'aa',
        'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a',
        'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
        'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
        'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o',
        'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u'
    };
    const replaced = lowered.replace(/[\u00C0-\u024F]/g, ch => map[ch] || ch);
    // Remove combining marks and punctuation, collapse whitespace
    return replaced
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    const norm = normalizeDanish(text);
    return norm.length ? norm.split(' ') : [];
}

function computeIsOpen(statusText, deadline) {
    const now = Date.now();
    const deadlineTs = deadline ? new Date(deadline).getTime() : null;
    const statusNorm = normalizeDanish(statusText || '');
    // Broader detection of open/closed states in Danish
    const statusHintsOpen = /(i hoering|i horing|i høring|open|aaben|åben|aktiv|offentlig|hoering|horing)/.test(statusNorm);
    const statusHintsClosed = /(afslut|luk|lukket|afsluttet|konklud|konklusion|konkluderet)/.test(statusNorm);
    if (Number.isFinite(deadlineTs)) {
        if (deadlineTs >= now) return true;
        if (deadlineTs < now && statusHintsClosed) return false;
    }
    if (statusHintsOpen) return true;
    if (statusHintsClosed) return false;
    return false;
}

function enrichHearingForIndex(h) {
    const normalizedTitle = normalizeDanish(h.title || '');
    const titleTokens = tokenize(h.title || '');
    const id = Number(h.id);
    const deadlineTs = h.deadline ? new Date(h.deadline).getTime() : null;
    const isOpen = computeIsOpen(h.status, h.deadline);
    return {
        id,
        title: h.title || '',
        startDate: h.startDate || null,
        deadline: h.deadline || null,
        status: h.status || null,
        normalizedTitle,
        titleTokens,
        deadlineTs,
        isOpen
    };
}

function loadIndexFromDisk() {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const json = JSON.parse(raw);
        if (Array.isArray(json?.items)) hearingIndex = json.items.map(enrichHearingForIndex);
        else if (Array.isArray(json?.hearings)) hearingIndex = json.hearings.map(enrichHearingForIndex);
    } catch {}
}

async function warmHearingIndex() {
    try {
        const baseApi = 'https://blivhoert.kk.dk/api/hearing';
        const baseUrl = 'https://blivhoert.kk.dk';
        let page = 1;
        const pageSize = 50;
        const collected = [];
        for (;;) {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            const r = await axios.get(url, { validateStatus: () => true });
            if (r.status !== 200 || !r.data) break;
            const data = r.data;
            const items = Array.isArray(data?.data) ? data.data : [];
            const included = Array.isArray(data?.included) ? data.included : [];
            const titleByContentId = new Map();
            for (const inc of included) {
                if (inc?.type === 'content') {
                    const fieldId = inc?.relationships?.field?.data?.id;
                    if (String(fieldId) === '1' && typeof inc?.attributes?.textContent === 'string') {
                        titleByContentId.set(String(inc.id), String(inc.attributes.textContent).trim());
                    }
                }
            }
            const outPage = [];
            for (const it of items) {
                if (!it || it.type !== 'hearing') continue;
                const hId = Number(it.id);
                const attrs = it.attributes || {};
                let title = '';
                const contentRels = (it.relationships?.contents?.data) || [];
                for (const cref of contentRels) {
                    const cid = cref?.id && String(cref.id);
                    if (cid && titleByContentId.has(cid)) { title = titleByContentId.get(cid); break; }
                }
                const statusRelId = it.relationships?.hearingStatus?.data?.id;
                const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                const statusText = statusIncluded?.attributes?.name || null;
                outPage.push({ id: hId, title, startDate: attrs.startDate || null, deadline: attrs.deadline || null, status: statusText || null });
            }
            collected.push(...outPage);
            const totalPages = data?.meta?.Pagination?.totalPages || page;
            if (page >= totalPages) break;
            page += 1;
        }
        hearingIndex = collected.map(enrichHearingForIndex);

        // Backfill missing titles by parsing the hearing page HTML (__NEXT_DATA__) with small concurrency
        let missing = hearingIndex.filter(h => !h.title || !h.title.trim());
        let retryCount = 0;
        const maxRetries = 3;
        
        while (missing.length > 0 && retryCount < maxRetries) {
            if (retryCount > 0) {
                console.log(`Retrying to fetch titles for ${missing.length} hearings (attempt ${retryCount + 1})`);
                await sleep(1000 * retryCount); // Progressive backoff
            }
            const axiosInstance = axios.create({
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Cookie': 'kk-xyz=1'
                },
                timeout: 20000,
                validateStatus: () => true
            });

            async function fetchMetaFromHearingHtml(hearingId) {
                try {
                    const url = `${baseUrl}/hearing/${hearingId}`;
                    const resp = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 2, baseDelayMs: 400 });
                    if (resp.status !== 200 || !resp.data) return {};
                    const $ = cheerio.load(resp.data);
                    const nextDataEl = $('script#__NEXT_DATA__');
                    if (!nextDataEl.length) return {};
                    // Guard against extremely large __NEXT_DATA__ blobs that can cause OOM in constrained envs
                    const rawNext = String(nextDataEl.html() || '');
                    const maxBytes = Number(process.env.NEXT_DATA_MAX_BYTES || 2500000); // ~2.5MB default
                    if (rawNext.length > maxBytes) {
                        return {};
                    }
                    let nextJson;
                    try { nextJson = JSON.parse(rawNext); } catch (_) { return {}; }
                    // Reuse extractor for meta if possible
                    let title = null, deadline = null, startDate = null, status = null;
                    const dehydrated = nextJson?.props?.pageProps?.dehydratedState;
                    if (dehydrated && Array.isArray(dehydrated.queries)) {
                        for (const q of dehydrated.queries) {
                            const data = q?.state?.data?.data;
                            const hearingObj = data?.data && data?.data?.type === 'hearing' ? data?.data : null;
                            if (hearingObj && hearingObj.attributes) {
                                deadline = hearingObj.attributes.deadline || deadline;
                                startDate = hearingObj.attributes.startDate || startDate;
                            }
                            const included = data?.included || [];
                            const contents = included.filter(x => x?.type === 'content');
                            const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                            if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());

                            // status may be in included as hearingStatus
                            const statusRelId = hearingObj?.relationships?.hearingStatus?.data?.id;
                            const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                            status = statusIncluded?.attributes?.name || status;
                        }
                    }
                    if (!status && deadline) status = (new Date(deadline) < new Date()) ? 'Konkluderet' : 'Afventer konklusion';
                    return { title, deadline, startDate, status };
                } catch (_) { return {}; }
            }

            // Fallback: try the public JSON API for a single hearing to extract title and dates
            async function fetchMetaFromApi(hearingId) {
                try {
                    const url = `${baseApi}/${hearingId}`;
                    const r = await axios.get(url, { validateStatus: () => true, headers: { Accept: 'application/json' } });
                    if (r.status !== 200 || !r.data) return {};
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    let title = '';
                    const contents = included.filter(x => x?.type === 'content');
                    const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                    if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
                    const attrs = item?.attributes || {};
                    const statusRelId = item?.relationships?.hearingStatus?.data?.id;
                    const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                    const status = statusIncluded?.attributes?.name || null;
                    return { title, deadline: attrs.deadline || null, startDate: attrs.startDate || null, status };
                } catch (_) { return {}; }
            }

            const concurrency = 5;
            let idx = 0;
            const runners = new Array(concurrency).fill(0).map(async () => {
                while (idx < missing.length) {
                    const mine = idx++;
                    const h = missing[mine];
                    let meta = await fetchMetaFromHearingHtml(h.id);
                    if (!meta.title) {
                        const viaApi = await fetchMetaFromApi(h.id);
                        meta = { ...viaApi, ...meta };
                    }
                    if (meta && (meta.title || meta.deadline || meta.startDate || meta.status)) {
                        // update in-memory
                        const target = hearingIndex.find(x => x.id === h.id);
                        if (target) {
                            target.title = meta.title || target.title;
                            target.startDate = meta.startDate || target.startDate;
                            target.deadline = meta.deadline || target.deadline;
                            target.status = meta.status || target.status;
                            target.normalizedTitle = normalizeDanish(target.title || '');
                            target.titleTokens = tokenize(target.title || '');
                            target.deadlineTs = target.deadline ? new Date(target.deadline).getTime() : null;
                            target.isOpen = computeIsOpen(target.status, target.deadline);
                        }
                    }
                }
            });
            await Promise.all(runners);
            
            // Check which ones still don't have titles
            missing = hearingIndex.filter(h => !h.title || !h.title.trim());
            retryCount++;
        }
        
        if (missing.length > 0) {
            console.warn(`Failed to fetch titles for ${missing.length} hearings after ${maxRetries} attempts`);
        }

        try {
            // Persist the possibly backfilled items to disk in the original shape
            const toWrite = hearingIndex.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
            fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items: toWrite }, null, 2));
        } catch {}
    } catch (e) {
        console.warn('warmHearingIndex failed:', e.message);
    }
}

// Sophisticated, Danish-aware suggest-as-you-type search endpoint
app.get('/api/search', async (req, res) => {
    const raw = String(req.query.q || '').trim();
    const q = normalizeDanish(raw);
    if (!q || q.length < 2) return res.json({ success: true, suggestions: [] });

    const isNumeric = /^\d+$/.test(raw.trim());

    function score(hi) {
        let s = 0;
        let matched = false;
        // ID prioritization
        if (isNumeric) {
            const rawNum = raw.trim();
            if (String(hi.id) === rawNum) { s += 120; matched = true; }
            else if (String(hi.id).startsWith(rawNum)) { s += 90; matched = true; }
            else if (String(hi.id).includes(rawNum)) { s += 10; matched = true; }
        }

        // Title scoring
        const titleNorm = hi.normalizedTitle;
        const tokens = hi.titleTokens;
        if (titleNorm.startsWith(q)) { s += 80; matched = true; }
        if (tokens.some(t => t.startsWith(q))) { s += 70; matched = true; }
        if (titleNorm.includes(q)) { s += 55; matched = true; }

        // Very light fuzzy: single deletion/insertion within small tokens
        if (q.length >= 3) {
            for (const t of tokens) {
                const dl = Math.abs(t.length - q.length);
                if (dl <= 1) {
                    const len = Math.min(t.length, q.length);
                    let diffs = 0;
                    for (let i = 0; i < len && diffs <= 1; i++) if (t[i] !== q[i]) diffs++;
                    if (diffs <= 1) { s += 40; matched = true; break; }
                }
            }
        }

        // If we had no match at all, exclude this item entirely
        if (!matched) return 0;

        // Boost open/active and upcoming deadlines (only after a match)
        if (hi.isOpen) s += 8;
        if (hi.deadlineTs) {
            const days = Math.max(0, Math.floor((hi.deadlineTs - Date.now()) / (24*3600*1000)));
            s += Math.max(0, 20 - Math.min(days, 20));
        }
        return s;
    }

        let ranked = hearingIndex
        .map(h => ({ h, s: score(h) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s || (a.h.deadlineTs || Infinity) - (b.h.deadlineTs || Infinity))
        .slice(0, 50);

    // On-demand title backfill for top items with missing/blank title (can be disabled via env)
    try {
        if (String(process.env.DISABLE_SEARCH_REMOTE_BACKFILL || '').toLowerCase() === 'true') {
            throw new Error('remote backfill disabled');
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': 'kk-xyz=1'
            },
            timeout: 25000
        });
        const toFix = ranked.filter(x => !(x.h.title && String(x.h.title).trim())).slice(0, 8);
        for (const item of toFix) {
            try {
                const root = await fetchHearingRootPage(baseUrl, item.h.id, axiosInstance);
                if (root?.nextJson) {
                    const meta = extractMetaFromNextJson(root.nextJson);
                    if (meta?.title) {
                        const idx = hearingIndex.findIndex(hh => hh.id === item.h.id);
                        if (idx >= 0) {
                            hearingIndex[idx].title = meta.title;
                            hearingIndex[idx].normalizedTitle = normalizeDanish(meta.title);
                            hearingIndex[idx].titleTokens = tokenize(meta.title);
                        }
                    }
                }
            } catch {}
        }
        // Re-rank after possible updates
        ranked = hearingIndex
            .map(h => ({ h, s: score(h) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s || (a.h.deadlineTs || Infinity) - (b.h.deadlineTs || Infinity))
            .slice(0, 50);
    } catch {}

    const out = ranked.map(x => ({
            id: x.h.id,
            title: (x.h.title && String(x.h.title).trim()) ? x.h.title : `Høring ${x.h.id}`,
            startDate: x.h.startDate,
            deadline: x.h.deadline,
            status: x.h.status
        }));

    res.json({ success: true, suggestions: out });
});

// Full hearings index with optional filtering and ordering
app.get('/api/hearings', (req, res) => {
    try {
        const { q = '' } = req.query;
        const raw = String(q || '').trim();
        const norm = normalizeDanish(raw);

        let results = hearingIndex.slice();
        if (norm) {
            const isNumeric = /^\d+$/.test(raw);
            results = results.filter(hi => {
                if (isNumeric) {
                    if (String(hi.id).includes(raw)) return true;
                }
                if (hi.normalizedTitle.includes(norm)) return true;
                if (hi.titleTokens.some(t => t.startsWith(norm))) return true;
                return false;
            });
        }

        // Sort: open first, then by deadline asc, then title
        results.sort((a, b) => {
            if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
            const da = a.deadlineTs || Infinity;
            const db = b.deadlineTs || Infinity;
            if (da !== db) return da - db;
            return a.title.localeCompare(b.title, 'da');
        });

        const out = results.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
        res.json({ success: true, total: out.length, hearings: out });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

function fixEncoding(text) {
    if (typeof text !== 'string') return text;
    // Fix common encoding issues
    return text
        .replace(/\uFFFD/g, '') // Remove replacement character
        .replace(/Ã¦/g, 'æ')
        .replace(/Ã¸/g, 'ø')
        .replace(/Ã¥/g, 'å')
        .replace(/Ã†/g, 'Æ')
        .replace(/Ã˜/g, 'Ø')
        .replace(/Ã…/g, 'Å')
        .replace(/â€"/g, '–')
        .replace(/â€™/g, "'")
        .replace(/â€œ/g, '"')
        .replace(/â€/g, '"')
        .trim();
}

function buildFileUrl(_baseUrl, filePath, fileName) {
    if (!filePath) return null;
    const qs = new URLSearchParams();
    qs.set('path', filePath);
    if (fileName) qs.set('filename', fileName);
    return `/api/file-proxy?${qs.toString()}`;
}

// Proxy to try known download routes and stream back to client
app.get('/api/file-proxy', async (req, res) => {
    try {
        const rawPath = String(req.query.path || '').trim();
        if (!rawPath) return res.status(400).json({ success: false, message: 'Missing path' });
        const fileName = String(req.query.filename || '').trim();
        const baseUrl = 'https://blivhoert.kk.dk';
        const encoded = encodeURIComponent(rawPath);

        const hearingIdMatch = rawPath.match(/Hearing-(\d+)/i);
        const referer = hearingIdMatch ? `${baseUrl}/hearing/${hearingIdMatch[1]}/comments` : `${baseUrl}`;

        const apiKey = process.env.BLIWHOERT_API_KEY || process.env.NEXT_PUBLIC_EXT_X_API_HEADER || process.env.X_API_HEADER;
        const customHeaderName = process.env.FILE_API_HEADER_NAME || process.env.EXT_FILE_API_HEADER_NAME || '';
        const customHeaderValue = process.env.FILE_API_HEADER_VALUE || process.env.EXT_FILE_API_HEADER_VALUE || '';
        const extraCookie = process.env.BLIWHOERT_COOKIE || '';
        const withKey = apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : '';
        const candidates = /^https?:\/\//i.test(rawPath)
            ? [rawPath]
            : [
                // API route with query apiKey
                `${baseUrl}/api/file?path=${encoded}${withKey}`,
                // API route relying on header-based key
                `${baseUrl}/api/file?path=${encoded}`,
                // File route variants
                `${baseUrl}/file?path=${encoded}${withKey}`,
                `${baseUrl}/file?path=${encoded}`,
                // Raw path (rarely exposed, but try)
                `${baseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}${withKey ? (rawPath.includes('?')?'&':'?')+withKey.slice(1):''}`
            ];

        const axiosClient = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
                'Referer': referer,
                'Origin': baseUrl,
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': `${extraCookie ? extraCookie + '; ' : ''}kk-xyz=1`,
                ...(apiKey ? { 'X-API-KEY': apiKey, 'X-API-HEADER': apiKey } : {}),
                ...(customHeaderName && customHeaderValue ? { [customHeaderName]: customHeaderValue } : {})
            },
            responseType: 'stream',
            validateStatus: () => true,
            timeout: 30000
        });

        let streamResp;
        for (const u of candidates) {
            try {
                const r = await axiosClient.get(u);
                if (r.status === 200 && r.data) { streamResp = r; break; }
            } catch (_) {}
        }
        // Retry with small backoff if not found
        if (!streamResp) {
            await sleep(400);
            for (const u of candidates) {
                try {
                    const r = await axiosClient.get(u);
                    if (r.status === 200 && r.data) { streamResp = r; break; }
                } catch (_) {}
            }
        }
        if (!streamResp) {
            return res.status(404).json({ success: false, message: 'Fil ikke fundet' });
        }
        const dispositionName = fileName || 'dokument.pdf';
        res.setHeader('Content-Disposition', `inline; filename="${dispositionName}"`);
        const ctype = streamResp.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', ctype);
        streamResp.data.pipe(res);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Proxy-fejl', error: e.message });
    }
});

// HEAD helper to allow UI to estimate token size of file links
app.head('/api/file-proxy', async (req, res) => {
    try {
        const rawPath = String(req.query.path || '').trim();
        if (!rawPath) return res.status(400).end();
        const fileName = String(req.query.filename || '').trim();
        const baseUrl = 'https://blivhoert.kk.dk';
        const encoded = encodeURIComponent(rawPath);
        const apiKey = process.env.BLIWHOERT_API_KEY || process.env.NEXT_PUBLIC_EXT_X_API_HEADER || process.env.X_API_HEADER;
        const withKey = apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : '';
        const candidates = /^https?:\/\//i.test(rawPath)
            ? [rawPath]
            : [
                `${baseUrl}/api/file?path=${encoded}${withKey}`,
                `${baseUrl}/api/file?path=${encoded}`,
                `${baseUrl}/file?path=${encoded}${withKey}`,
                `${baseUrl}/file?path=${encoded}`,
                `${baseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}${withKey ? (rawPath.includes('?')?'&':'?')+withKey.slice(1):''}`
            ];
        for (const u of candidates) {
            try {
                const r = await axios.head(u, { validateStatus: () => true });
                if (r.status === 200) {
                    if (r.headers['content-length']) res.setHeader('Content-Length', r.headers['content-length']);
                    if (r.headers['content-type']) res.setHeader('Content-Type', r.headers['content-type']);
                    return res.status(200).end();
                }
            } catch {}
        }
        return res.status(404).end();
    } catch {
        return res.status(500).end();
    }
});

// Strict extractor: build responses from a Next.js dehydrated JSON root (one page)
async function extractStructuredFromNextJson(jsonRoot, baseUrl) {
    const out = [];
    let totalPages = null;
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];
        
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;

            const envelope = root;
            // Update totalPages from the envelope meta if available
            const pagesFromEnvelope = envelope?.meta?.Pagination?.totalPages;
            if (typeof pagesFromEnvelope === 'number' && pagesFromEnvelope > 0) {
                totalPages = pagesFromEnvelope;
            }

            const maybeArray = Array.isArray(envelope?.data) ? envelope.data : (Array.isArray(envelope?.data?.data) ? envelope.data.data : null);
            if (maybeArray && maybeArray.some(item => item?.type === 'comment')) {
                const comments = maybeArray;
                const included = envelope?.included || [];
                
                const contentById = new Map();
                included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
                
                const userById = new Map();
                included.filter(x => x?.type === 'user').forEach(u => userById.set(String(u.id), u));
                
                const companyById = new Map();
                included.filter(x => x?.type === 'company').forEach(c => companyById.set(String(c.id), c));
                                
                for (const item of comments) {
                    if (!item || item.type !== 'comment') continue;
                    
                    const attrs = item.attributes || {};
                    const rel = item.relationships || {};
                    
                    const responseNumber = attrs.number || null;
                    const created = attrs.created || null;
                    const withdrawn = attrs.withdrawn || attrs.isDeleted || false;
                    const onBehalfOf = attrs.onBehalfOf || null;
                                    
                    let author = null;
                    let organization = null;
                    let authorAddress = null;
                                    
                    const userRelId = rel?.user?.data?.id && String(rel.user.data.id);
                    if (userRelId && userById.has(userRelId)) {
                        const u = userById.get(userRelId);
                        const uattrs = u?.attributes || {};
                        author = uattrs.employeeDisplayName || uattrs.email || uattrs.identifier || null;
                                        
                        const street = uattrs.streetName || '';
                        const postal = uattrs.postalCode || '';
                        const city = uattrs.city || '';
                        authorAddress = [street, postal, city].filter(Boolean).join(', ') || null;

                        const companyRelId = u?.relationships?.company?.data?.id && String(u.relationships.company.data.id);
                        if (companyRelId && companyById.has(companyRelId)) {
                            const comp = companyById.get(companyRelId);
                            organization = comp?.attributes?.name || null;
                        }
                    }
                                    
                    const contentRels = Array.isArray(rel?.contents?.data) ? rel.contents.data : [];
                    let text = '';
                    const attachments = [];
                                    
                    for (const cref of contentRels) {
                        const cid = cref?.id && String(cref.id);
                        if (!cid || !contentById.has(cid)) continue;
                        
                        const c = contentById.get(cid);
                        const cattrs = c?.attributes || {};
                        const hasText = typeof cattrs.textContent === 'string' && cattrs.textContent.trim().length > 0;
                        const hasFile = typeof cattrs.filePath === 'string' && cattrs.filePath.trim().length > 0;

                        if (hasText) {
                            text += (text ? '\n\n' : '') + String(cattrs.textContent).trim();
                        }
                        if (hasFile) {
                            const filePath = String(cattrs.filePath || '').trim();
                            const fileName = String(cattrs.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                            attachments.push({ 
                                url: buildFileUrl(baseUrl, filePath, fileName),
                                filename: fileName
                            });
                        }
                    }

                    if (!withdrawn && (text.trim().length > 0 || attachments.length > 0)) {
                        out.push({
                            responseNumber,
                            text: fixEncoding(text || ''),
                            author: author || null,
                            authorAddress,
                            organization: organization || null,
                            onBehalfOf: onBehalfOf || null,
                            submittedAt: created || null,
                            attachments
                        });
                    }
                }
            }
        }
        
        return { responses: out, totalPages };
    } catch (e) {
        console.error("Error in extractStructuredFromNextJson:", e);
        return { responses: out, totalPages: null };
    }
}

// Extract hearing materials (files, external document links, and full hearing text) from Next.js dehydrated JSON on the hearing root page
function extractMaterialsFromNextJson(jsonRoot, baseUrl) {
    const materials = [];
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;

            const envelope = root;
            const hearingObj = envelope?.data && envelope?.data?.type === 'hearing' ? envelope.data : null;
            if (!hearingObj) continue;

            const included = Array.isArray(envelope?.included) ? envelope.included : [];
            const contentById = new Map();
            included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));

            const contentRefs = Array.isArray(hearingObj?.relationships?.contents?.data) ? hearingObj.relationships.contents.data : [];

            let combinedText = '';
            const discoveredLinks = new Map(); // url -> { title }

            function shouldIgnoreExternal(url) {
                const u = String(url).toLowerCase();
                if (u.includes('klagevejledning')) return true;
                if (u.includes('kk.dk/dagsordener-og-referater')) return true;
                // Allow direct Plandata document PDFs
                const isPlanDocPdf = /dokument\.plandata\.dk\/.*\.pdf(\?|$)/.test(u);
                if (isPlanDocPdf) return false;
                // Ignore other generic Plandata/Plst pages
                if (u.includes('plst.dk') || u.includes('plandata.dk') || u.includes('plandata')) return true;
                return false;
            }

            function addLink(url, title) {
                if (!url) return;
                const clean = String(url).trim();
                if (!clean) return;
                if (shouldIgnoreExternal(clean)) return;
                if (!discoveredLinks.has(clean)) discoveredLinks.set(clean, { title: title || clean });
            }

            for (const cref of contentRefs) {
                const cid = cref?.id && String(cref.id);
                if (!cid || !contentById.has(cid)) continue;
                const c = contentById.get(cid);
                const a = c?.attributes || {};
                const rel = c?.relationships || {};
                const isHearingField = !!(rel?.field?.data?.id);
                const isCommentContent = !!(rel?.comment?.data?.id);
                const hasText = typeof a.textContent === 'string' && a.textContent.trim().length > 0;
                const hasFile = typeof a.filePath === 'string' && a.filePath.trim().length > 0;

                // Include text from any hearing field content (not comments)
                if (hasText && isHearingField && !isCommentContent) {
                    const text = String(a.textContent).trim();
                    combinedText += (combinedText ? '\n\n' : '') + text;
                    // Extract markdown-style links [title](url)
                    const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
                    let m;
                    while ((m = mdLinkRe.exec(text)) !== null) {
                        addLink(m[2], m[1]);
                    }
                    // Extract bare URLs
                    const urlRe = /(https?:\/\/[^\s)]+)(?![^\[]*\])/g;
                    let u;
                    while ((u = urlRe.exec(text)) !== null) {
                        addLink(u[1]);
                    }
                }
                // Include files that belong to hearing fields (not comments)
                if (hasFile && isHearingField && !isCommentContent) {
                    const filePath = String(a.filePath || '').trim();
                    if (!/\/(fields|Fields)\//.test(filePath)) {
                        // Some deployments use different path segments; still allow if relationship indicates a hearing field
                        // Keep permissive to avoid missing materials
                    }
                    const fileName = String(a.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                    materials.push({
                        type: 'file',
                        title: fileName,
                        url: buildFileUrl(baseUrl, filePath, fileName)
                    });
                }
            }

            if (combinedText.trim().length > 0) {
                materials.push({ type: 'description', title: 'Høringstekst', content: fixEncoding(combinedText) });
            }

            // Add discovered external document links as file-like entries (prioritize obvious document URLs)
            for (const [url, meta] of discoveredLinks.entries()) {
                // Only include external document links that are not in the ignore list (already filtered)
                const lower = url.toLowerCase();
                const looksDoc = /\.(pdf|doc|docx|xls|xlsx)$/i.test(lower);
                if (looksDoc) {
                    materials.push({ type: 'file', title: meta.title || url, url });
                }
            }
        }
    } catch (e) {
        console.error('Error in extractMaterialsFromNextJson:', e);
    }
    // De-duplicate by (title,url)
    const seen = new Set();
    const deduped = [];
    for (const m of materials) {
        const key = `${m.type}|${m.title || ''}|${m.url || ''}|${(m.content || '').slice(0,50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(m);
    }
    return deduped;
}

// Extract hearing meta (title, dates, status) from Next.js dehydrated JSON
function extractMetaFromNextJson(jsonRoot) {
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];
        let title = null, deadline = null, startDate = null, status = null;
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;
            const envelope = root;
            const hearingObj = envelope?.data && envelope?.data?.type === 'hearing' ? envelope.data : null;
            if (hearingObj && hearingObj.attributes) {
                deadline = hearingObj.attributes.deadline || deadline;
                startDate = hearingObj.attributes.startDate || startDate;
            }
            const included = Array.isArray(envelope?.included) ? envelope.included : [];
            const contents = included.filter(x => x?.type === 'content');
            const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
            if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
            const statusRelId = hearingObj?.relationships?.hearingStatus?.data?.id;
            const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
            status = statusIncluded?.attributes?.name || status;
        }
        return { title, deadline, startDate, status };
    } catch {
        return { title: null, deadline: null, startDate: null, status: null };
    }
}

async function fetchHearingRootPage(baseUrl, hearingId, axiosInstance) {
    const url = `${baseUrl}/hearing/${hearingId}`;
    const resp = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 3, baseDelayMs: 600 });
    if (resp.status !== 200 || !resp.data) { logDebug(`[fetchHearingRootPage] ${url} -> HTTP ${resp.status}`); return { materials: [], nextJson: null }; }
    const $ = cheerio.load(resp.data);
    const nextDataEl = $('script#__NEXT_DATA__');
    if (!nextDataEl.length) { logDebug(`[fetchHearingRootPage] ${url} -> missing __NEXT_DATA__`); return { materials: [], nextJson: null }; }
    const rawNext = String(nextDataEl.html() || '');
    const maxBytes = Number(process.env.NEXT_DATA_MAX_BYTES || 2500000);
    if (rawNext.length > maxBytes) { logDebug(`[fetchHearingRootPage] ${url} -> __NEXT_DATA__ too large (${rawNext.length} > ${maxBytes})`); return { materials: [], nextJson: null }; }
    let nextJson; try { nextJson = JSON.parse(rawNext); } catch (_) { return { materials: [], nextJson: null }; }
    const materials = extractMaterialsFromNextJson(nextJson, baseUrl);
    logDebug(`[fetchHearingRootPage] ${url} -> materials=${materials.length}`);
    return { materials, nextJson };
}

// Fetch a Next.js comments page and extract responses for that page
async function fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance) {
    const tryUrls = [
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?Page=${pageIndex}` : ''}`,
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?PageIndex=${pageIndex}` : ''}`
    ];
    for (const url of tryUrls) {
        const resp = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 3, baseDelayMs: 500 });
        if (resp.status !== 200 || !resp.data) { logDebug(`[fetchCommentsPage] ${url} -> HTTP ${resp.status}`); continue; }
        const $ = cheerio.load(resp.data);
        const nextDataEl = $('script#__NEXT_DATA__');
        if (!nextDataEl.length) { logDebug(`[fetchCommentsPage] ${url} -> missing __NEXT_DATA__`); continue; }
        const rawNext = String(nextDataEl.html() || '');
        const maxBytes = Number(process.env.NEXT_DATA_MAX_BYTES || 2500000);
        if (rawNext.length > maxBytes) { logDebug(`[fetchCommentsPage] ${url} -> __NEXT_DATA__ too large (${rawNext.length} > ${maxBytes})`); continue; }
        let nextJson; try { nextJson = JSON.parse(rawNext); } catch (_) { continue; }
        const { responses, totalPages } = await extractStructuredFromNextJson(nextJson, baseUrl);
        logDebug(`[fetchCommentsPage] ${url} -> responses=${responses.length}, totalPages=${totalPages}`);
        return { responses, totalPages, nextJson };
    }
    return { responses: [], totalPages: null, nextJson: null };
}

// Fallback: Use the public API endpoints directly if HTML/Next data is not available
async function fetchCommentsViaApi(apiBaseUrl, hearingId, axiosInstance) {
    const all = [];
    let totalPages = null;
    const url = `${apiBaseUrl}/hearing/${hearingId}/comment`;
    const maxPages = 100;

    async function fetchPage(idx, paramKey) {
        return withRetries(() => axiosInstance.get(url, {
            validateStatus: () => true,
            headers: { Accept: 'application/json' },
            params: { include: 'Contents,Contents.ContentType', [paramKey]: idx }
        }), { attempts: 2, baseDelayMs: 300 });
    }

    // Detect which param key to use
    let paramKey = 'Page';
    let resp = await fetchPage(1, 'Page');
    let items = Array.isArray(resp?.data?.data) ? resp.data.data : [];
    if (resp.status !== 200 || items.length === 0) {
        const respAlt = await fetchPage(1, 'PageIndex');
        const itemsAlt = Array.isArray(respAlt?.data?.data) ? respAlt.data.data : [];
        if (respAlt.status === 200 && itemsAlt.length > 0) {
            paramKey = 'PageIndex';
            resp = respAlt;
            items = itemsAlt;
        }
    }
    if (resp?.status !== 200 || !resp?.data) return { responses: [], totalPages: null };
    const includedFirst = Array.isArray(resp?.data?.included) ? resp.data.included : [];
    const pageResponsesFirst = await mapCommentsFromJsonApi(items, includedFirst, apiBaseUrl.replace('/api', ''));
    totalPages = resp?.data?.meta?.Pagination?.totalPages || null;
    if (Array.isArray(pageResponsesFirst) && pageResponsesFirst.length) all.push(...pageResponsesFirst);

    // Fetch remaining pages
    let consecutiveEmpty = 0;
    const lastPage = Number.isFinite(totalPages) && totalPages > 0 ? Math.min(totalPages, maxPages) : maxPages;
    for (let pageIndex = 2; pageIndex <= lastPage; pageIndex += 1) {
        const r = await fetchPage(pageIndex, paramKey);
        if (r.status !== 200 || !r.data) { consecutiveEmpty += 1; if (consecutiveEmpty >= 2 && !Number.isFinite(totalPages)) break; else continue; }
        const itemsN = Array.isArray(r?.data?.data) ? r.data.data : [];
        const includedN = Array.isArray(r?.data?.included) ? r.data.included : [];
        const pageResponses = await mapCommentsFromJsonApi(itemsN, includedN, apiBaseUrl.replace('/api', ''));
        if (!Array.isArray(pageResponses) || pageResponses.length === 0) {
            consecutiveEmpty += 1;
            if (consecutiveEmpty >= 2 && !Number.isFinite(totalPages)) break;
        } else {
            consecutiveEmpty = 0;
            all.push(...pageResponses);
        }
        if (Number.isFinite(totalPages) && totalPages > 0 && pageIndex >= totalPages) break;
    }
    return { responses: all, totalPages };
}

async function mapCommentsFromJsonApi(comments, included, baseUrl) {
    const contentById = new Map();
    included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));

    const userById = new Map();
    included.filter(x => x?.type === 'user').forEach(u => userById.set(String(u.id), u));

    const companyById = new Map();
    included.filter(x => x?.type === 'company').forEach(c => companyById.set(String(c.id), c));

    const outPromises = comments.map(async (item) => {
        if (!item || item.type !== 'comment') return null;
        const attrs = item.attributes || {};
        const rel = item.relationships || {};
        const responseNumber = attrs.number || null;
        const created = attrs.created || null;
        const withdrawn = attrs.withdrawn || attrs.isDeleted || false;
        const onBehalfOf = attrs.onBehalfOf || null;

        let author = null;
        let organization = null;
        let authorAddress = null;

        const userRelId = rel?.user?.data?.id && String(rel.user.data.id);
        if (userRelId && userById.has(userRelId)) {
            const u = userById.get(userRelId);
            const uattrs = u?.attributes || {};
            author = uattrs.employeeDisplayName || uattrs.email || uattrs.identifier || null;
            const street = uattrs.streetName || '';
            const postal = uattrs.postalCode || '';
            const city = uattrs.city || '';
            authorAddress = [street, postal, city].filter(Boolean).join(', ') || null;
            const companyRelId = u?.relationships?.company?.data?.id && String(u.relationships.company.data.id);
            if (companyRelId && companyById.has(companyRelId)) {
                const comp = companyById.get(companyRelId);
                organization = comp?.attributes?.name || null;
            }
        }

        const contentRels = Array.isArray(rel?.contents?.data) ? rel.contents.data : [];
        let text = '';
        
        const attachmentPromises = contentRels.map(async (cref) => {
            const cid = cref?.id && String(cref.id);
            if (!cid || !contentById.has(cid)) return null;
            const c = contentById.get(cid);
            const cattrs = c?.attributes || {};
            const hasText = typeof cattrs.textContent === 'string' && cattrs.textContent.trim().length > 0;
            if (hasText) {
                text += (text ? '\n\n' : '') + String(cattrs.textContent).trim();
            }
            const hasFile = typeof cattrs.filePath === 'string' && cattrs.filePath.trim().length > 0;
            if (hasFile) {
                const filePath = String(cattrs.filePath || '').trim();
                const fileName = String(cattrs.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                return { url: buildFileUrl(baseUrl, filePath, fileName), filename: fileName };
            }
            return null;
        }).filter(Boolean);

        const attachments = (await Promise.all(attachmentPromises)).filter(Boolean);

        if (!withdrawn && (text.trim().length > 0 || attachments.length > 0)) {
            return {
                responseNumber,
                text: fixEncoding(text || ''),
                author: author || null,
                authorAddress,
                organization: organization || null,
                onBehalfOf: onBehalfOf || null,
                submittedAt: created || null,
                attachments
            };
        }
        return null;
    });

    return (await Promise.all(outPromises)).filter(Boolean);
}

function normalizeResponses(responses) {
    // Ensure deterministic sort and normalized shapes for API consumers
    const cleaned = responses
        .filter(r => r && (typeof r.responseNumber === 'number' || typeof r.responseNumber === 'string'))
        .map(r => ({
            id: Number(r.responseNumber),
            text: r.text || '',
            author: r.author || null,
            authorAddress: r.authorAddress || null,
            organization: r.organization || null,
            onBehalfOf: r.onBehalfOf || null,
            submittedAt: r.submittedAt || null,
            attachments: Array.isArray(r.attachments) ? r.attachments.map(a => ({
                filename: a.filename || (a.url ? String(a.url).split('/').pop() : 'Dokument'),
                url: a.url
            })) : []
        }));
    cleaned.sort((a, b) => (a.id || 0) - (b.id || 0));
    return cleaned;
}

function mergeResponsesPreferFullText(a, b) {
    const byId = new Map();
    const add = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const r of arr) {
            if (!r) continue;
            const idKey = Number(r.responseNumber ?? r.id);
            const existing = byId.get(idKey);
            if (!existing) byId.set(idKey, r);
            else {
                const existingTextLen = (existing.text || '').length;
                const newTextLen = (r.text || '').length;
                if (newTextLen > existingTextLen) byId.set(idKey, r);
            }
        }
    };
    add(a);
    add(b);
    return Array.from(byId.values());
}


// API endpoint to fetch hearing data
app.get('/api/hearing/:id', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const noCache = String(req.query.nocache || '').trim() === '1';
        const dbOnly = String(req.query.db || '').trim() === '1';
        logDebug(`[api/hearing] start id=${hearingId} dbOnly=${dbOnly} noCache=${noCache} persist=${String(req.query.persist||'')}`);
        if (dbOnly) {
            try {
                const fromDb = readAggregate(hearingId);
                if (fromDb && fromDb.hearing) {
                    logDebug(`[api/hearing] dbOnly hit id=${hearingId} responses=${(fromDb.responses||[]).length}`);
                    return res.json({ success: true, found: true, hearing: fromDb.hearing, totalResponses: (fromDb.responses||[]).length, responses: fromDb.responses });
                }
                logDebug(`[api/hearing] dbOnly miss id=${hearingId}`);
                return res.json({ success: true, found: false });
            } catch (e) {
                logDebug(`[api/hearing] dbOnly exception id=${hearingId} err=${e && e.message}`);
                return res.json({ success: true, found: false });
            }
        }
        // Prefer persisted on disk if requested or configured and not stale
        try {
            const preferPersist = PERSIST_PREFER || String(req.query.persist || '').trim() === '1';
            if (preferPersist) {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                if (persisted && persisted.success && Array.isArray(persisted.responses) && !isPersistStale(meta)) {
                    logDebug(`[api/hearing] persisted hit id=${hearingId} responses=${persisted.responses.length}`);
                    return res.json({ success: true, hearing: persisted.hearing, totalPages: persisted.totalPages || undefined, totalResponses: persisted.responses.length, responses: persisted.responses });
                }
            }
        } catch (_) {}
        // Serve from SQLite first if available
        try {
            const fromDb = readAggregate(hearingId);
            if (!noCache && fromDb && fromDb.hearing) {
                logDebug(`[api/hearing] sqlite hit id=${hearingId} responses=${(fromDb.responses||[]).length}`);
                return res.json({ success: true, hearing: fromDb.hearing, totalPages: undefined, totalResponses: (fromDb.responses||[]).length, responses: fromDb.responses });
            }
        } catch (_) {}
        if (!noCache) {
            const cached = cacheGet(hearingAggregateCache, hearingId);
            if (cached) { logDebug(`[api/hearing] memory cache hit id=${hearingId} responses=${(cached.responses||[]).length||0}`); return res.json(cached); }
        }
        const baseUrl = 'https://blivhoert.kk.dk';

        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': 'kk-xyz=1',
                'Referer': `${baseUrl}/hearing/${hearingId}/comments`,
                'Origin': baseUrl
            },
            timeout: 30000,
        });

        // Full HTML scrape for all pages, as it's the most reliable source for attachments.
        let htmlResponses = [];
        let totalPages = 1;
        try {
            const first = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, 1, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            htmlResponses = first.responses || [];
            totalPages = first.totalPages || 1;
            // If totalPages known, fetch remaining in parallel with small concurrency; otherwise sequential with guard
            if (typeof totalPages === 'number' && totalPages > 1) {
                const remaining = [];
                for (let p = 2; p <= totalPages; p += 1) remaining.push(p);
                const maxConcurrent = 4;
                let cursor = 0;
                const workers = new Array(Math.min(maxConcurrent, remaining.length)).fill(0).map(async () => {
                    while (cursor < remaining.length) {
                        const myIdx = cursor++;
                        const p = remaining[myIdx];
                        const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, p, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                        const pageItems = Array.isArray(result.responses) ? result.responses : [];
                        if (pageItems.length) htmlResponses = htmlResponses.concat(pageItems);
                    }
                });
                await Promise.all(workers);
            } else {
                // Unknown page count: sequential until 2 consecutive empties OR duplicate detection
                let pageIndex = 2;
                let consecutiveEmpty = 0;
                let lastFirstId = htmlResponses[0]?.responseNumber ?? null;
                for (;;) {
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (!pageItems.length) {
                        consecutiveEmpty += 1;
                        if (consecutiveEmpty >= 2) break;
                    } else {
                        consecutiveEmpty = 0;
                        // If site serves page 1 for all indices, detect duplicate first id
                        const currentFirstId = pageItems[0]?.responseNumber ?? null;
                        if (lastFirstId !== null && currentFirstId !== null && currentFirstId === lastFirstId) break;
                        lastFirstId = currentFirstId;
                        htmlResponses = htmlResponses.concat(pageItems);
                    }
                    // Keep totalPages up to date if extractor discovered it later
                    if (!totalPages && result.totalPages) totalPages = result.totalPages;
                    pageIndex += 1;
                    if (pageIndex > 200) break; // hard cap safety
                }
            }
            logDebug(`[aggregate] hearing=${hearingId} htmlResponses=${htmlResponses.length} totalPages=${totalPages}`);
        } catch (_) {
            // Gracefully fallback if HTML scraping fails.
            htmlResponses = [];
            totalPages = 1;
        }

        // Also fetch from the API as a fallback and for merging.
        const apiBaseUrl = `${baseUrl}/api`;
        let viaApi = { responses: [], totalPages: null };
        try {
            viaApi = await fetchCommentsViaApi(apiBaseUrl, hearingId, axiosInstance);
        } catch (_) {
            // Ignore API errors and rely on HTML scrape results.
        }

        // Merge results, giving preference to ones with more text, then normalize.
        const merged = mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []);
        const normalizedResponses = normalizeResponses(merged);
        
        // Use the most reliable totalPages count.
        totalPages = viaApi.totalPages || totalPages;

        // Try to improve meta by parsing root page __NEXT_DATA__ if index lacks data
        let hearingMeta = { title: null, deadline: null, startDate: null, status: null };
        try {
            const rootPage = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            if (rootPage.nextJson) hearingMeta = extractMetaFromNextJson(rootPage.nextJson);
        } catch {}

        // Fallback: Public JSON API for a single hearing to extract title/dates/status
        if (!hearingMeta.title || !hearingMeta.deadline || !hearingMeta.startDate || !hearingMeta.status) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { validateStatus: () => true, headers: { Accept: 'application/json' } });
                if (r.status === 200 && r.data) {
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    const contents = included.filter(x => x?.type === 'content');
                    const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                    const attrs = item?.attributes || {};
                    const statusRelId = item?.relationships?.hearingStatus?.data?.id;
                    const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                    hearingMeta = {
                        title: hearingMeta.title || (titleContent ? fixEncoding(String(titleContent.attributes.textContent).trim()) : null),
                        deadline: hearingMeta.deadline || attrs.deadline || null,
                        startDate: hearingMeta.startDate || attrs.startDate || null,
                        status: hearingMeta.status || statusIncluded?.attributes?.name || null
                    };
                }
            } catch {}
        }
        const hearingInfoFromIndex = hearingIndex.find(h => String(h.id) === hearingId) || {};
        const hearing = {
            id: Number(hearingId),
            title: hearingMeta.title || hearingInfoFromIndex.title || `Høring ${hearingId}`,
            startDate: hearingMeta.startDate || hearingInfoFromIndex.startDate || null,
            deadline: hearingMeta.deadline || hearingInfoFromIndex.deadline || null,
            status: hearingMeta.status || hearingInfoFromIndex.status || 'ukendt',
            url: `${baseUrl}/hearing/${hearingId}/comments`
        };

        // Update in-memory index with improved meta for future searches
        try {
            const idx = hearingIndex.findIndex(h => h.id === Number(hearingId));
            if (idx >= 0) {
                const updated = { ...hearingIndex[idx] };
                updated.title = hearing.title;
                updated.startDate = hearing.startDate;
                updated.deadline = hearing.deadline;
                updated.status = hearing.status;
                updated.normalizedTitle = normalizeDanish(updated.title || '');
                updated.titleTokens = tokenize(updated.title || '');
                updated.deadlineTs = updated.deadline ? new Date(updated.deadline).getTime() : null;
                updated.isOpen = computeIsOpen(updated.status, updated.deadline);
                hearingIndex[idx] = updated;
            }
        } catch {}

        const payload = {
            success: true,
            hearing,
            totalPages,
            totalResponses: normalizedResponses.length,
            responses: normalizedResponses
        };
        try { upsertHearing(hearing); replaceResponses(hearing.id, normalizedResponses); } catch (_) {}
        cacheSet(hearingAggregateCache, hearingId, payload);
        logDebug(`[api/hearing] success id=${hearingId} responses=${normalizedResponses.length} totalPages=${totalPages}`);
        res.json(payload);
    } catch (error) {
        console.error(`Error in /api/hearing/${req.params.id}:`, error.message);
        res.status(500).json({ success: false, message: 'Uventet fejl', error: error.message });
    }
});

// Split endpoints: meta and responses separately
app.get('/api/hearing/:id/meta', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'kk-xyz=1' }, timeout: 30000 });

        let hearingMeta = { title: null, deadline: null, startDate: null, status: null };
        try {
            const rootPage = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            if (rootPage.nextJson) hearingMeta = extractMetaFromNextJson(rootPage.nextJson);
        } catch {}
        if (!hearingMeta.title || !hearingMeta.deadline || !hearingMeta.startDate || !hearingMeta.status) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { validateStatus: () => true, headers: { Accept: 'application/json' } });
                if (r.status === 200 && r.data) {
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    const contents = included.filter(x => x?.type === 'content');
                    const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                    const attrs = item?.attributes || {};
                    const statusRelId = item?.relationships?.hearingStatus?.data?.id;
                    const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                    hearingMeta = {
                        title: hearingMeta.title || (titleContent ? fixEncoding(String(titleContent.attributes.textContent).trim()) : null),
                        deadline: hearingMeta.deadline || attrs.deadline || null,
                        startDate: hearingMeta.startDate || attrs.startDate || null,
                        status: hearingMeta.status || statusIncluded?.attributes?.name || null
                    };
                }
            } catch {}
        }

        const hearingInfoFromIndex = hearingIndex.find(h => String(h.id) === hearingId) || {};
        const hearing = {
            id: Number(hearingId),
            title: hearingMeta.title || hearingInfoFromIndex.title || `Høring ${hearingId}`,
            startDate: hearingMeta.startDate || hearingInfoFromIndex.startDate || null,
            deadline: hearingMeta.deadline || hearingInfoFromIndex.deadline || null,
            status: hearingMeta.status || hearingInfoFromIndex.status || 'ukendt',
            url: `${baseUrl}/hearing/${hearingId}/comments`
        };

        try {
            const idx = hearingIndex.findIndex(h => h.id === Number(hearingId));
            if (idx >= 0) {
                const updated = { ...hearingIndex[idx] };
                updated.title = hearing.title;
                updated.startDate = hearing.startDate;
                updated.deadline = hearing.deadline;
                updated.status = hearing.status;
                updated.normalizedTitle = normalizeDanish(updated.title || '');
                updated.titleTokens = tokenize(updated.title || '');
                updated.deadlineTs = updated.deadline ? new Date(updated.deadline).getTime() : null;
                updated.isOpen = computeIsOpen(updated.status, updated.deadline);
                hearingIndex[idx] = updated;
            }
        } catch {}

        res.json({ success: true, hearing });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

app.get('/api/hearing/:id/responses', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const noCache = String(req.query.nocache || '').trim() === '1';
        const preferPersist = PERSIST_PREFER || String(req.query.persist || '').trim() === '1';
        if (preferPersist) {
            const meta = readPersistedHearingWithMeta(hearingId);
            const persisted = meta?.data;
            if (persisted && persisted.success && Array.isArray(persisted.responses) && !isPersistStale(meta)) {
                return res.json({ success: true, totalResponses: persisted.responses.length, responses: persisted.responses });
            }
        }
        if (!noCache) {
            const cached = cacheGet(hearingResponsesCache, hearingId);
            if (cached) return res.json(cached);
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'kk-xyz=1', 'Referer': `${baseUrl}/hearing/${hearingId}/comments` }, timeout: 30000 });
        // HTML route
        const first = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, 1, axiosInstance), { attempts: 3, baseDelayMs: 600 });
        let htmlResponses = first.responses || [];
        let totalPages = first.totalPages || 1;
        if (typeof totalPages === 'number' && totalPages > 1) {
            const remaining = [];
            for (let p = 2; p <= totalPages; p += 1) remaining.push(p);
            const maxConcurrent = 4;
            let cursor = 0;
            const workers = new Array(Math.min(maxConcurrent, remaining.length)).fill(0).map(async () => {
                while (cursor < remaining.length) {
                    const myIdx = cursor++;
                    const p = remaining[myIdx];
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, p, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (pageItems.length) htmlResponses = htmlResponses.concat(pageItems);
                }
            });
            await Promise.all(workers);
        } else {
            // Unknown page count: sequential until 2 consecutive empties OR duplicate detection
            let pageIndex = 2;
            let consecutiveEmpty = 0;
            let lastFirstId = htmlResponses[0]?.responseNumber ?? null;
            for (;;) {
                const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                const pageItems = Array.isArray(result.responses) ? result.responses : [];
                if (!pageItems.length) {
                    consecutiveEmpty += 1;
                    if (consecutiveEmpty >= 2) break;
                } else {
                    consecutiveEmpty = 0;
                    const currentFirstId = pageItems[0]?.responseNumber ?? null;
                    if (lastFirstId !== null && currentFirstId !== null && currentFirstId === lastFirstId) break;
                    lastFirstId = currentFirstId;
                    htmlResponses = htmlResponses.concat(pageItems);
                }
                if (!totalPages && result.totalPages) totalPages = result.totalPages;
                pageIndex += 1;
                if (pageIndex > 200) break;
            }
        }
        // API route and merge
        const apiBaseUrl = `${baseUrl}/api`;
        const viaApi = await withRetries(() => fetchCommentsViaApi(apiBaseUrl, hearingId, axiosInstance), { attempts: 2, baseDelayMs: 500 });
        const merged = mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []);
        const normalized = normalizeResponses(merged);
        const payload = { success: true, totalResponses: normalized.length, responses: normalized };
        cacheSet(hearingResponsesCache, hearingId, payload);
        if (PERSIST_ALWAYS_WRITE) {
            const existingMeta = readPersistedHearingWithMeta(hearingId);
            const existing = existingMeta?.data || null;
            const merged = mergePersistPayload(existing, payload);
            writePersistedHearing(hearingId, merged);
        }
        res.json(payload);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

// Materials endpoint: returns hearing materials (files, external document links and full hearing text)
app.get('/api/hearing/:id/materials', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const noCache = String(req.query.nocache || '').trim() === '1';
        const dbOnly = String(req.query.db || '').trim() === '1';
        logDebug(`[api/materials] start id=${hearingId} dbOnly=${dbOnly} noCache=${noCache} persist=${String(req.query.persist||'')}`);
        if (dbOnly) {
            try {
                const rows = sqliteDb && sqliteDb.prepare ? sqliteDb.prepare(`SELECT * FROM materials WHERE hearing_id=? ORDER BY idx ASC`).all(hearingId) : [];
                const materials = (rows||[]).map(m => ({ type: m.type, title: m.title, url: m.url, content: m.content }));
                logDebug(`[api/materials] dbOnly ${materials.length}`);
                return res.json({ success: true, found: materials.length > 0, materials });
            } catch {
                logDebug(`[api/materials] dbOnly exception`);
                return res.json({ success: true, found: false, materials: [] });
            }
        }
        const preferPersist = PERSIST_PREFER || String(req.query.persist || '').trim() === '1';
        if (preferPersist) {
            const meta = readPersistedHearingWithMeta(hearingId);
            const persisted = meta?.data;
            if (persisted && persisted.success && Array.isArray(persisted.materials) && !isPersistStale(meta)) {
                logDebug(`[api/materials] persisted hit ${persisted.materials.length}`);
                return res.json({ success: true, materials: persisted.materials });
            }
        }
        if (!noCache) {
            const cached = cacheGet(hearingMaterialsCache, hearingId);
            if (cached) { logDebug(`[api/materials] memory cache hit ${(cached.materials||[]).length}`); return res.json(cached); }
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'kk-xyz=1', 'Accept-Language': 'da-DK,da;q=0.9', 'Referer': `${baseUrl}/hearing/${hearingId}` }, timeout: 30000 });

        // Primary: parse hearing root page (__NEXT_DATA__)
        let materials = [];
        try {
            const res1 = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            materials = res1.materials || [];
        } catch (_) {}

        // Fallback: JSON API if needed (map field contents; also discover document links)
        if (!materials.length) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { validateStatus: () => true, headers: { Accept: 'application/json' } });
                if (r.status === 200 && r.data) {
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    const contentById = new Map();
                    included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
                    const refs = Array.isArray(item?.relationships?.contents?.data) ? item.relationships.contents.data : [];
                    let combinedText = '';
                    const discoveredLinks = new Map();

                    function shouldIgnoreExternal(url) {
                        const u = String(url).toLowerCase();
                        if (u.includes('klagevejledning')) return true;
                        if (u.includes('kk.dk/dagsordener-og-referater')) return true;
                        const isPlanDocPdf = /dokument\.plandata\.dk\/.*\.pdf(\?|$)/i.test(u);
                        if (isPlanDocPdf) return false;
                        if (u.includes('plst.dk') || u.includes('plandata.dk') || u.includes('plandata')) return true;
                        return false;
                    }
                    function addLink(url, title) {
                        if (!url) return;
                        const clean = String(url).trim();
                        if (!clean) return;
                        if (shouldIgnoreExternal(clean)) return;
                        if (!discoveredLinks.has(clean)) discoveredLinks.set(clean, { title: title || clean });
                    }

                    for (const ref of refs) {
                        const cid = ref?.id && String(ref.id);
                        if (!cid || !contentById.has(cid)) continue;
                        const c = contentById.get(cid);
                        const a = c?.attributes || {};
                        const rel = c?.relationships || {};
                        const isHearingField = !!(rel?.field?.data?.id);
                        const isCommentContent = !!(rel?.comment?.data?.id);
                        if (typeof a.textContent === 'string' && a.textContent.trim() && isHearingField && !isCommentContent) {
                            const text = a.textContent.trim();
                            combinedText += (combinedText ? '\n\n' : '') + text;
                            const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
                            let m;
                            while ((m = mdLinkRe.exec(text)) !== null) addLink(m[2], m[1]);
                            const urlRe = /(https?:\/\/[^\s)]+)(?![^\[]*\])/g;
                            let u;
                            while ((u = urlRe.exec(text)) !== null) addLink(u[1]);
                        }
                        if (typeof a.filePath === 'string' && a.filePath.trim() && isHearingField && !isCommentContent) {
                            const filePath = String(a.filePath).trim();
                            const fileName = String(a.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                            materials.push({ type: 'file', title: fileName, url: buildFileUrl(baseUrl, filePath, fileName) });
                        }
                    }
                    if (combinedText.trim()) materials.push({ type: 'description', title: 'Høringstekst', content: fixEncoding(combinedText) });
                    for (const [url, meta] of discoveredLinks.entries()) {
                        if (/\.(pdf|doc|docx|xls|xlsx)(\?|$)/i.test(url)) materials.push({ type: 'file', title: meta.title || url, url });
                    }
                    // Deduplicate
                    const seen = new Set();
                    const deduped = [];
                    for (const m of materials) {
                        const key = `${m.type}|${m.title || ''}|${m.url || ''}|${(m.content || '').slice(0,50)}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        deduped.push(m);
                    }
                    materials = deduped;
                }
            } catch (_) {}
        }

        const payload = { success: true, materials };
        try { replaceMaterials(hearingId, materials); } catch (_) {}
        cacheSet(hearingMaterialsCache, hearingId, payload);
        logDebug(`[api/materials] success id=${hearingId} materials=${materials.length}`);
        res.json(payload);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

// Upload custom attachments (user-provided) to include as materials
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Ingen fil modtaget' });
        const storedPath = req.file.path;
        const original = req.file.originalname || 'fil';
        const hearingId = Number(req.query.hearingId || req.body?.hearingId);
        if (Number.isFinite(hearingId)) {
            try { addUpload(req.sessionID, hearingId, storedPath, original); } catch (_) {}
        }
        res.json({ success: true, file: { path: storedPath, originalName: original } });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Upload-fejl', error: e.message });
    }
});

// Warm a hearing in background (scrape + persist), non-blocking
app.post('/api/warm/:id', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        logDebug(`[warm] queue id=${hearingId}`);
        // Fire-and-forget: trigger internal fetches without waiting for completion
        (async () => {
            try { await axios.get(`http://localhost:${PORT}/api/hearing/${encodeURIComponent(hearingId)}?nocache=1`, { validateStatus: () => true, timeout: 120000 }); } catch (e) { logDebug(`[warm] hearing fetch failed id=${hearingId} ${e && e.message}`); }
            try { await axios.get(`http://localhost:${PORT}/api/hearing/${encodeURIComponent(hearingId)}/materials?nocache=1`, { validateStatus: () => true, timeout: 120000 }); } catch (e) { logDebug(`[warm] materials fetch failed id=${hearingId} ${e && e.message}`); }
        })();
        res.json({ success: true, queued: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke starte opvarmning' });
    }
});

// Extract text from simple formats to preview (txt, md, docx via python-docx, pdf via pdf-parse)
app.post('/api/extract-text', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { filePath, mimeType, originalName } = req.body || {};
        if (!filePath) return res.status(400).json({ success: false, message: 'Mangler filePath' });
        const lower = String(originalName || '').toLowerCase();
        const isPdf = lower.endsWith('.pdf') || mimeType === 'application/pdf';
        const isDocx = lower.endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const isText = lower.endsWith('.txt') || lower.endsWith('.md') || /^text\//.test(String(mimeType || ''));
        if (isText) {
            const txt = fs.readFileSync(filePath, 'utf8');
            return res.json({ success: true, text: txt.slice(0, 200000) });
        }
        if (isPdf) {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(dataBuffer);
            return res.json({ success: true, text: String(parsed.text || '').slice(0, 200000) });
        }
        if (isDocx) {
            const python = process.env.PYTHON_BIN || 'python3';
            const script = `import sys\nfrom docx import Document\np=Document(sys.argv[1])\nprint('\n'.join([p2.text for p2 in p.paragraphs]))`;
            const tmpPy = path.join(ensureTmpDir(), `read_${Date.now()}.py`);
            fs.writeFileSync(tmpPy, script, 'utf8');
            await new Promise((resolve, reject) => {
                const c = spawn(python, [tmpPy, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '', err = '';
                c.stdout.on('data', d => out += d.toString());
                c.stderr.on('data', d => err += d.toString());
                c.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
            }).then(txt => {
                res.json({ success: true, text: String(txt || '').slice(0, 200000) });
            }).catch(e => {
                res.status(500).json({ success: false, message: 'Kunne ikke læse DOCX', error: e.message });
            });
            return;
        }
        return res.json({ success: true, text: '' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved udtræk', error: e.message });
    }
});

// Session-backed edits and selections
app.post('/api/session/edits/:id', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const { responseId, patch } = req.body || {};
        if (!Number.isFinite(hearingId) || !Number.isFinite(responseId)) {
            return res.status(400).json({ success: false, message: 'Ugyldige parametre' });
        }
        upsertSessionEdit(sessionId, hearingId, responseId, patch || {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved gemning af ændring' });
    }
});

app.get('/api/session/edits/:id', (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const edits = getSessionEdits(sessionId, hearingId);
        res.json({ success: true, edits });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved hentning af ændringer' });
    }
});

app.post('/api/session/materials/:id', express.json({ limit: '256kb' }), (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const { idx, included } = req.body || {};
        if (!Number.isFinite(idx)) return res.status(400).json({ success: false, message: 'Ugyldigt index' });
        setMaterialFlag(sessionId, hearingId, Number(idx), !!included);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved opdatering af materialevalg' });
    }
});

app.get('/api/session/materials/:id', (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const flags = getMaterialFlags(sessionId, hearingId);
        res.json({ success: true, flags });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved hentning af materialevalg' });
    }
});

app.get('/api/session/uploads/:id', (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const files = listUploads(sessionId, hearingId);
        res.json({ success: true, files });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved hentning af uploads' });
    }
});

// Auto-classify respondents using OpenAI based on responses content and metadata
app.post('/api/auto-classify-respondents/:id', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!hearingId) return res.status(400).json({ success: false, message: 'Mangler hørings-ID' });

        if (!openai) {
            return res.status(400).json({ success: false, message: 'OPENAI_API_KEY mangler – kan ikke klassificere automatisk.' });
        }

        // Fetch current hearing data (meta + responses) with a fast, local-first strategy to avoid long hangs
        let responses = [];
        try {
            const fromDb = readAggregate(hearingId);
            if (fromDb && Array.isArray(fromDb.responses) && fromDb.responses.length) {
                responses = fromDb.responses;
            }
        } catch {}
        if (!responses.length) {
            try {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                if (persisted && persisted.success && Array.isArray(persisted.responses) && !isPersistStale(meta)) {
                    responses = persisted.responses;
                }
            } catch {}
        }
        if (!responses.length) {
            // Try to fetch and persist immediately (blocking, but short) before queuing
            try {
                const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                await axios.get(`${base}/api/hearing/${encodeURIComponent(hearingId)}?nocache=1`, { validateStatus: () => true, timeout: 45000 });
            } catch {}
            // Re-check DB and persisted after fetch attempt
            try {
                const fromDb2 = readAggregate(hearingId);
                if (fromDb2 && Array.isArray(fromDb2.responses) && fromDb2.responses.length) {
                    responses = fromDb2.responses;
                }
            } catch {}
            if (!responses.length) {
                try {
                    const meta2 = readPersistedHearingWithMeta(hearingId);
                    const persisted2 = meta2?.data;
                    if (persisted2 && persisted2.success && Array.isArray(persisted2.responses) && !isPersistStale(meta2)) {
                        responses = persisted2.responses;
                    }
                } catch {}
            }
            if (!responses.length) {
                // As a final step, queue a prefetch and return 202
                try {
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                    axios.post(`${base}/api/prefetch/${encodeURIComponent(hearingId)}`, {}, { validateStatus: () => true, timeout: 10000 }).catch(() => {});
                } catch {}
                return res.status(202).json({ success: true, suggestions: [], queued: true, message: 'Data for høringen er ikke klar endnu. Forvarmer i baggrunden – prøv igen om lidt.' });
            }
        }
        if (!responses.length) {
            return res.json({ success: true, suggestions: [] });
        }

        // Build compact classification payload for the model
        const items = responses.map(r => ({
            id: r.id,
            author: r.author || null,
            organization: r.organization || null,
            onBehalfOf: r.onBehalfOf || null,
            respondentName: r.respondentName || r.respondentnavn || null,
            respondentType: r.respondentType || r.respondenttype || null,
            text: String(r.text || '').slice(0, 1200)
        }));

        const systemPrompt = readTextFileSafe(CLASSIFIER_PROMPT_PATH) || [
            'Du er en hjælper, der klassificerer afsendere af høringssvar.',
            'Regler:',
            '- Privatpersoner skal forblive anonyme: lad dem stå som respondentType "Borger" og respondentName "Borger" (ændr ikke).',
            '- Lokaludvalg: sæt respondentType til "Lokaludvalg" og respondentName til det konkrete lokaludvalgs navn (f.eks. "Amager Øst Lokaludvalg").',
            '- Offentlige myndigheder (forvaltninger, ministerier, styrelser, direktorater, kommunale enheder): sæt respondentType til "Offentlig myndighed" og respondentName til myndighedens navn (f.eks. "Teknik- og Miljøforvaltningen", "Transportministeriet").',
            '- Beboergrupper: sæt respondentType til "Beboergruppe" og respondentName til gruppens navn (f.eks. "Beboergruppen X").',
            '- Brug kun oplysninger, der kan udledes tydeligt af de givne felter (author, organization, onBehalfOf, text). Gæt ikke.',
            '- Hvis du er i tvivl, så behold/foreslå ikke ændringer (spring over).',
            '- Hvis respondentType allerede er en af de ovenstående med tydeligt navn, kan du bekræfte det i output.',
            'Returnér KUN JSON (ingen forklaringer). Format: [{"id": <nummer>, "respondentName": "...", "respondentType": "..."}]',
            'Medtag kun elementer, hvor der bør sættes en mere specifik type/navn end standarden "Borger".'
        ].join('\n');

        const userPrompt = [
            'Klassificér følgende høringssvar efter reglerne og returnér kun JSON-listen beskrevet ovenfor.',
            'Svardata:',
            JSON.stringify(items, null, 2)
        ].join('\n\n');

        let outputText = '';
        try {
            const params = {
                model: MODEL_ID,
                input: [
                    { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
                    { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                ],
                stream: false
            };
            if (Number.isFinite(MAX_TOKENS) && MAX_TOKENS > 0) params.max_output_tokens = MAX_TOKENS;

            const resp = await openai.responses.create(params);
            if (resp) {
                if (typeof resp.output_text === 'string') outputText = resp.output_text;
                else if (Array.isArray(resp.output_text)) outputText = resp.output_text.join('\n');
                else if (Array.isArray(resp.output)) {
                    try { outputText = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n'); } catch (_) {}
                }
            }
        } catch (e) {
            // Surface JSON with message, but continue to prefer clear error
            return res.status(500).json({ success: false, message: 'OpenAI-kald fejlede', error: e && e.message ? e.message : String(e) });
        }

        const cleaned = String(outputText || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();
        let suggestions = [];
        try {
            const parsed = JSON.parse(cleaned || '[]');
            if (Array.isArray(parsed)) suggestions = parsed
                .filter(x => x && (Number.isFinite(x.id) || /^\d+$/.test(String(x.id))))
                .map(x => ({
                    id: Number(x.id),
                    respondentName: typeof x.respondentName === 'string' ? x.respondentName : undefined,
                    respondentType: typeof x.respondentType === 'string' ? x.respondentType : undefined
                }))
                .filter(x => x.respondentName || x.respondentType);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Kunne ikke parse OpenAI-svar som JSON', raw: outputText });
        }

        return res.json({ success: true, suggestions });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

// Summarization endpoint: builds 3 variants from fetched materials + responses and streams results
app.get('/api/summarize/:id', async (req, res) => {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try { if (typeof req.setTimeout === 'function') req.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}
    try { if (typeof res.setTimeout === 'function') res.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}

    const t0 = performance.now();

    // Keep-alive pings to prevent proxies/timeouts during long generations
    const keepAlive = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
            else clearInterval(keepAlive);
        } catch (_) { try { clearInterval(keepAlive); } catch(_) {} }
    }, 15000);

    const sendEvent = (eventName, data) => {
        if (!res.writableEnded) {
            res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };
    
    // Handle client disconnect
    req.on('close', () => {
        try { clearInterval(keepAlive); } catch (_) {}
        if (!res.writableEnded) {
            res.end();
            logDebug('[summarize] Client disconnected, closing SSE connection.');
        }
    });

    try {
        // In background mode, proxy via job + polling over SSE (no direct OpenAI streaming)
        // Respect explicit bg=0 to force direct streaming and avoid DB inserts
        const bgParam = String(req.query.bg || '').trim().toLowerCase();
        const forceDirect = bgParam === '0' || bgParam === 'false' || bgParam === 'no';
        if (BACKGROUND_MODE && !forceDirect) {
            await legacySummarizeAsJobSse(req, res, null);
            return;
        }
        // Optional demo mode for instant UX testing without OpenAI latency
        const DEMO = String(req.query.demo || '') === '1';
        if (DEMO) {
            const n = Number(req.query.n || 3);
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const demoDelay = Number(req.query.delay || process.env.DEMO_DELAY_MS || 400);
            sendEvent('info', { message: `DEMO: Genererer ${n} varianter...` });
            for (let i = 1; i <= n; i++) {
                await sleep(demoDelay);
                // flush a tiny heartbeat to encourage chunking immediately after headers in some proxies
                try { if (!res.writableEnded) res.write(': tick\n\n'); } catch(_) {}
                sendEvent('info', { message: `DEMO: Genererer variant ${i} af ${n}...` });
                sendEvent('placeholder', { id: i });
                await sleep(demoDelay);
                sendEvent('status', { id: i, phase: 'started', message: 'Job startet…' });
                const steps = [
                    'Identificerer gennemgående temaer',
                    'Vurderer prioritet: klima, trafik, byrum',
                    'Afklarer enighed/uenighed i indsigter',
                    'Matcher krav i materialet',
                    'Skitserer struktureret output'
                ];
                sendEvent('status', { id: i, phase: 'thinking', message: 'Modellen overvejer…' });
                for (const s of steps) { await sleep(demoDelay); sendEvent('summary', { id: i, text: s }); }
                await sleep(demoDelay);
                sendEvent('status', { id: i, phase: 'drafting', message: 'Skriver udkast…' });
                const markdown = `# Opsummering (DEMO ${i})\n\n## Klima\nFlere ønsker grønne tage.\n\n## Mobilitet\nCykelstier prioriteres.\n\n## Bykvalitet\nGrønne opholdszoner foreslås.`;
                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                await sleep(demoDelay);
                sendEvent('variant', { variant: { id: i, headings, markdown, summary: steps.join('\n') } });
                await sleep(demoDelay);
                sendEvent('status', { id: i, phase: 'done', message: 'Færdig' });
            }
            sendEvent('end', { message: 'Færdig med at generere (DEMO).' });
            return res.end();
        }

        if (!openai) {
            sendEvent('status', { phase: 'openai', message: 'OPENAI_API_KEY mangler – kører ikke OpenAI.' });
            sendEvent('error', { message: 'Manglende OPENAI_API_KEY i miljøet. Tilføj nøglen og prøv igen.' });
            return res.end();
        } else {
            sendEvent('status', { phase: 'openai', message: 'Forbundet til OpenAI.' });
        }
        
        const hearingId = String(req.params.id).trim();
        const providedResponsesMd = null;
        const providedMaterialMd = null;

        // Pre-show variant placeholders so UI has per-variant status while data loads
        const nEarly = Number(req.query.n || 3);
        try {
            for (let i = 1; i <= nEarly; i++) {
                sendEvent('placeholder', { id: i });
                sendEvent('status', { id: i, phase: 'preparing', message: 'Forbereder variant…' });
            }
        } catch (_) {}

        sendEvent('info', { message: 'Henter høringsdata...' });

        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        sendEvent('status', { phase: 'fetching', message: 'Henter høringsdata…' });
        // Stream periodic progress while aggregator runs
        let fetchSeconds = 0;
        const fetchTicker = setInterval(() => {
            fetchSeconds += 2;
            try { sendEvent('info', { message: `Henter høringsdata… (${fetchSeconds}s)` }); } catch {}
        }, 2000);
        const metaResp = await axios.get(`${base}/api/hearing/${hearingId}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
        try { clearInterval(fetchTicker); } catch (_) {}

        if (!metaResp.data?.success) {
            sendEvent('error', { message: 'Kunne ikke hente høringsmetadata' });
            return res.end();
        }
        const hearing = metaResp.data.hearing;
        const responsesRaw = Array.isArray(metaResp.data?.responses) ? metaResp.data.responses : [];
        // Optional: apply respondent overrides passed via query (URL-encoded JSON)
        let responses = responsesRaw;
        try {
            const editsParam = req.query && req.query.edits ? String(req.query.edits) : '';
            let overrides = null;
            if (editsParam) {
                try { overrides = JSON.parse(editsParam); } catch (_) { overrides = null; }
            }
            if (overrides && typeof overrides === 'object') {
                responses = responsesRaw.map(r => {
                    const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                    const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                    if (!ov || typeof ov !== 'object') return r;
                    const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                    const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                    const patched = { ...r };
                    if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                    if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                    return patched;
                });
            }
        } catch (_) {}
        const materials = Array.isArray(metaResp.data?.materials) ? metaResp.data.materials : [];

        sendEvent('info', { message: 'Forbereder dokumenter...' });
        sendEvent('status', { phase: 'preparing', message: 'Forbereder materiale til prompt…' });
        
        const tmpDir = ensureTmpDir();
        const repliesMdPath = path.join(tmpDir, `hearing_${hearingId}_responses.md`);
        const materialMdPath = path.join(tmpDir, `hearing_${hearingId}_material.md`);

        // Stream immediate user-facing status while building prompt
        sendEvent('info', { message: 'Bygger materiale til prompt…' });
        const repliesParts = ['# Samlede Høringssvar'];
        for (const r of responses) {
            repliesParts.push(`## Svar ${r.id}`);
            // Prefer wizard-edited respondent name if available, then fallback to author/organization
            const prefName = r.respondentnavn || r.respondentName;
            const who = [prefName || r.author, r.organization && r.organization !== (prefName || r.author) ? r.organization : null].filter(Boolean).join(' ');
            if (who || r.submittedAt) {
                const parts = [];
                if (who) parts.push(who);
                if (r.submittedAt) parts.push(new Date(r.submittedAt).toISOString());
                repliesParts.push(`- ${parts.join(' • ')}`);
            }
            repliesParts.push('');
            repliesParts.push(r.text || '');
            if (Array.isArray(r.attachments) && r.attachments.length) {
                repliesParts.push('');
                repliesParts.push('Bilag:');
                for (const a of r.attachments) {
                    const safeUrl = a.url ? `${base}/api/file-proxy?${new URLSearchParams({ path: a.url, filename: a.filename || 'Dokument' }).toString()}` : '';
                    repliesParts.push(`- ${a.filename}: ${safeUrl || a.url || ''}`);
                }
            }
            repliesParts.push('');
        }
        const repliesMd = repliesParts.join('\n');
        fs.writeFileSync(repliesMdPath, repliesMd, 'utf8');

        const materialParts = [`# Høringsmateriale for ${hearing.title}`];
        for (const m of materials) {
            if (m.type === 'description' && m.content) {
                materialParts.push('');
                materialParts.push(m.content);
                materialParts.push('');
            } else if (m.type === 'file') {
                const proxied = m.url ? `${base}/api/file-proxy?${new URLSearchParams({ path: m.url, filename: m.title || 'Dokument' }).toString()}` : '';
                materialParts.push(`- ${m.title}: ${proxied || m.url}`);
            }
        }
        const materialMd = materialParts.join('\n');
        fs.writeFileSync(materialMdPath, materialMd, 'utf8');

        const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
        const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
        const RESP_LIMIT = Number(process.env.RESP_CHAR_LIMIT || 200000);
        const MAT_LIMIT = Number(process.env.MAT_CHAR_LIMIT || 120000);
        const userPrompt = `${promptTemplate}\n\n# Samlede Høringssvar\n\n${repliesMd.slice(0, RESP_LIMIT)}\n\n# Høringsmateriale \n\n${materialMd.slice(0, MAT_LIMIT)}`;
        logDebug(`[summarize] Constructed user prompt of length ${userPrompt.length}.`);

        if (userPrompt.length < 200) { // Arbitrary small length check
            sendEvent('error', { message: 'Fejl: Kunne ikke generere prompt. For lidt data at arbejde med.'});
            return res.end();
        }

        const n = nEarly;
        sendEvent('info', { message: `Genererer ${n} varianter...`, hearing });
        sendEvent('status', { phase: 'queueing', message: `Starter ${n} varianter…` });
        sendEvent('info', { message: 'Materiale klar', meta: { responses: responses.length, materials: materials.length, promptChars: userPrompt.length } });

        const model = MODEL_ID;
        const maxTokens = MAX_TOKENS;
        const supportsReasoning = /^(gpt-5|o3|o4)/i.test(model);

        // Compute fast pre-thought headings from input to show immediate reasoning summary
        function computePreThoughts(inputText) {
            const lc = String(inputText || '').toLowerCase();
            const buckets = [
                { key: 'trafik', label: 'Trafik og parkering', re: /trafik|parkering|bil|bus|kørsel|krydset|ve[jy]/g },
                { key: 'stoej', label: 'Støj og boldbane', re: /støj|stoej|boldbur|boldbane|støjværn|stoejvaern|larm/g },
                { key: 'skole', label: 'Skole og institution', re: /skole|institution|daginstitution|børnehave|vuggestue/g },
                { key: 'klima', label: 'Klima og grønne områder', re: /klima|grøn|groen|groent|biodivers|regnvand|træ|trae|grønt/g },
                { key: 'byg', label: 'Byggehøjde og skygge', re: /højde|hoejde|skygge|etage|høj|hoej|kollegium/g },
                { key: 'cykel', label: 'Cykel og mobilitet', re: /cykel|cykelsti|fortov|gående|gaaende|mobilitet/g },
                { key: 'tryg', label: 'Tryghed og sikkerhed', re: /tryghed|sikkerhed/g },
                { key: 'proces', label: 'Proces og inddragelse', re: /borgermøde|borgermoede|høring|hoering|proces/g }
            ];
            const scored = [];
            for (const b of buckets) {
                const m = lc.match(b.re);
                if (m && m.length) scored.push({ label: b.label, n: m.length });
            }
            scored.sort((a, b) => b.n - a.n);
            return scored.slice(0, 6).map(s => s.label);
        }
        const preThoughts = computePreThoughts(`${repliesMd}\n${materialMd}`);

        // Build tasks (potentially run in parallel)
        function extractHeadingsFromSummary(text) {
            try {
                const raw = String(text || '').replace(/\r/g, '');
                const byLine = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
                // Prefer explicit bullets or short sentences as headings
                const bullets = byLine
                    .filter(l => /^[-*••]|^\d+\./.test(l) || (l.length <= 120 && /[:–-]/.test(l)))
                    .map(l => l.replace(/^[-*•\d+.\s]+/, '').trim());
                const unique = [];
                const seen = new Set();
                for (const b of bullets) { if (!seen.has(b)) { seen.add(b); unique.push(b); } }
                return unique.slice(-6);
            } catch { return []; }
        }

        const tasks = Array.from({ length: n }, (_, idx) => async () => {
            const i = idx;
            let markdown = '';
            let summaryText = '';
            let currentHeadingsSnapshot = [];
            try {
                sendEvent('info', { message: `Genererer variant ${i + 1} af ${n}...` });
                // Ensure client renders a placeholder card for this variant
                sendEvent('placeholder', { id: i + 1 });
                sendEvent('status', { id: i + 1, phase: 'preparing', message: 'Forbereder variant…' });
                // Do NOT send identical pre-thoughts as live variant thoughts; avoid confusing duplicates across variants
                logDebug(`[summarize] calling streaming responses API model=${model} userPromptChars=${userPrompt.length}`);

                const params = {
                    model,
                    input: [
                        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
                        { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                    ],
                    stream: true
                };
                // Only send temperature for non-reasoning models that support it
                const isReasoningModel = /^(gpt-5|o3|o4)/i.test(model);
                if (!isReasoningModel && Number.isFinite(TEMPERATURE)) {
                    params.temperature = TEMPERATURE;
                }
                if (Number.isFinite(maxTokens) && maxTokens > 0) {
                    params.max_output_tokens = maxTokens;
                }
                // Attach verbosity and reasoning effort for supported reasoning models
                if (/^gpt-5/i.test(model)) {
                    if (VERBOSITY_ENV) params.text = { ...(params.text || {}), verbosity: VERBOSITY_ENV };
                }
                if (supportsReasoning && REASONING_EFFORT_ENV) {
                    params.reasoning = { ...(params.reasoning || {}), effort: REASONING_EFFORT_ENV };
                }

                logDebug(`[summarize] params keys: ${Object.keys(params).join(', ')}; hasTemp=${Object.prototype.hasOwnProperty.call(params,'temperature')}; maxOut=${params.max_output_tokens||null}; hasReasoning=${!!params.reasoning}; hasTextOpt=${!!params.text}`);
                const useBackground = parseBoolean(req.query.bg || req.query.background || OPENAI_BACKGROUND_DEFAULT);
                let stream;
                if (useBackground) {
                    // Create async background job, then stream by response_id for resilience
                    const createParams = { ...params, stream: false, background: true };
                    delete createParams.temperature; // ensure compatibility with reasoning models
                    logDebug(`[summarize] starting background job for variant ${i + 1}`);
                    const created = await openai.responses.create(createParams);
                    const responseId = created && (created.id || created.response_id || created.response?.id);
                    if (!responseId) throw new Error('Kunne ikke starte baggrundsjob');
                    sendEvent('info', { message: `Baggrundsjob startet for variant ${i + 1}…`, responseId });
                    sendEvent('status', { id: i + 1, phase: 'queued', message: 'Baggrundsjob oprettet…' });
                    sendEvent('status', { id: i + 1, phase: 'connecting', message: 'Tænker' });
                    stream = await openai.responses.stream({ response_id: responseId });
                } else {
                    // Try direct streaming; if the model/route rejects streaming immediately, fall back to non-stream and emit once
                    sendEvent('status', { id: i + 1, phase: 'connecting', message: 'Opretter direkte stream…' });
                    try {
                        stream = await openai.responses.stream(params);
                    } catch (e) {
                        logDebug(`[summarize] direct stream failed variant=${i+1}: ${e?.message||e}`);
                        // Non-stream fallback
                        const nonStreamParams = { ...params };
                        delete nonStreamParams.stream;
                        delete nonStreamParams.temperature;
                        const resp = await openai.responses.create(nonStreamParams);
                        let text = '';
                        if (resp) {
                            if (typeof resp.output_text === 'string') text = resp.output_text;
                            else if (Array.isArray(resp.output_text)) text = resp.output_text.join('\n');
                            else if (Array.isArray(resp.output)) {
                                try { text = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n'); } catch (_) {}
                            }
                        }
                        markdown = (text || '').trim();
                        if (markdown) {
                            const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                            const variant = { id: i + 1, headings, markdown, summary: (summaryText || '').trim() };
                            sendEvent('variant', { variant });
                            return;
                        }
                        throw e;
                    }
                }

                let lastReportedLen = 0;
                const seenHeadings = new Set();
                let gotFirstDelta = false;
                let gotReasoningDelta = false;
                const startedAtMs = Date.now();
                // Heartbeat: emit per-variant liveness status every 5s until completion
                const variantHeartbeat = setInterval(() => {
                    try {
                        if (res.writableEnded) { clearInterval(variantHeartbeat); return; }
                        const secs = Math.round((Date.now() - startedAtMs) / 1000);
                        if (!gotFirstDelta && !gotReasoningDelta) {
                            sendEvent('status', { id: i + 1, phase: 'connecting', message: `Tænker... (${secs}s)` });
                        } else if (gotReasoningDelta && !gotFirstDelta) {
                            sendEvent('status', { id: i + 1, phase: 'thinking', message: `Modellen overvejer… (${secs}s)` });
                        } else if (gotFirstDelta) {
                            sendEvent('status', { id: i + 1, phase: 'drafting', message: `Skriver udkast… (${secs}s)` });
                        }
                    } catch (_) {}
                }, 5000);
                for await (const event of stream) {
                    if (event && typeof event.type === 'string') {
                        if (event.type === 'response.created') {
                            sendEvent('status', { id: i + 1, phase: 'started', message: 'Job startet…' });
                        } else if (event.type.startsWith('response.tool_')) {
                            sendEvent('status', { id: i + 1, phase: 'using-tools', message: 'Kalder værktøjer…' });
                        } else if (event.type === 'response.completed') {
                            sendEvent('status', { id: i + 1, phase: 'done', message: 'Færdig' });
                            try { clearInterval(variantHeartbeat); } catch(_) {}
                        }
                    }
                    if (event.type === 'response.output_text.delta') {
                        // lightweight debug of stream progress
                        if (lastReportedLen === 0) logDebug(`[summarize] stream start variant=${i+1}`);
                        markdown += (event.delta || '');
                        if (!gotFirstDelta) {
                            gotFirstDelta = true;
                            sendEvent('status', { id: i + 1, phase: 'drafting', message: 'Skriver udkast…' });
                        }
                        if (markdown.length - lastReportedLen >= 200) {
                            const tmpHeadings = (markdown.match(/^#{1,6} .*$/mg) || []);
                            sendEvent('info', { message: `Skriver variant ${i + 1}...`, progress: { variant: i + 1, chars: markdown.length, headingsCount: tmpHeadings.length } });
                            lastReportedLen = markdown.length;
                            // Overflad nye overskrifter (fra selve output Markdown) som midlertidig "tanke-overskrifter"
                            const newOnes = [];
                            for (const h of tmpHeadings) {
                                if (!seenHeadings.has(h)) {
                                    seenHeadings.add(h);
                                    newOnes.push(h.replace(/^#{1,6}\s*/, ''));
                                }
                            }
                            if (newOnes.length) {
                                const merged = Array.from(new Set([...currentHeadingsSnapshot, ...newOnes])).slice(-6);
                                currentHeadingsSnapshot = merged;
                                sendEvent('headings', { id: i + 1, items: currentHeadingsSnapshot });
                            }
                            // Stream partial content so UI can render live answer
                            sendEvent('content', { id: i + 1, markdown });
                        }
                    } else if (
                        event.type === 'response.reasoning_summary.delta' ||
                        event.type === 'response.reasoning_summary_text.delta'
                    ) {
                        logDebug(`[summarize] reasoning delta variant=${i+1}`);
                        const delta = (typeof event.delta === 'string') ? event.delta : (event.delta?.toString?.() || '');
                        summaryText += (delta || '');
                        if (!gotReasoningDelta) {
                            gotReasoningDelta = true;
                            sendEvent('status', { id: i + 1, phase: 'thinking', message: 'Modellen overvejer…' });
                        }
                        const extracted = extractHeadingsFromSummary(summaryText);
                        if (extracted.length) {
                            currentHeadingsSnapshot = extracted;
                            sendEvent('headings', { id: i + 1, items: currentHeadingsSnapshot });
                        }
                    } else if (
                        event.type === 'response.reasoning_summary.done' ||
                        event.type === 'response.reasoning_summary_text.done'
                    ) {
                        logDebug(`[summarize] reasoning done variant=${i+1}`);
                        if (event.text) summaryText = event.text;
                        const extracted = extractHeadingsFromSummary(summaryText);
                        if (extracted.length) {
                            currentHeadingsSnapshot = extracted;
                            sendEvent('headings', { id: i + 1, items: currentHeadingsSnapshot });
                        }
                    } else if (event.type === 'response.error') {
                        throw new Error(event.error?.message || 'OpenAI fejl');
                    }
                }

                if (!markdown) {
                    // Fallback: try non-streaming request to retrieve full text
                    try {
                        const nonStreamParams = { ...params, stream: false };
                        delete nonStreamParams.temperature; // ensure safe for reasoning models
                        const resp = await openai.responses.create(nonStreamParams);
                        let text = '';
                        if (resp) {
                            if (typeof resp.output_text === 'string') text = resp.output_text;
                            else if (Array.isArray(resp.output_text)) text = resp.output_text.join('\n');
                            else if (Array.isArray(resp.output)) {
                                try {
                                    text = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n');
                                } catch (_) {}
                            }
                        }
                        markdown = (text || '').trim();
                    } catch (e) {
                        // ignore, handled below
                    }
                }
                if (!markdown) throw new Error('Tomt svar fra OpenAI');

                logDebug(`[summarize] success variant=${i + 1} length=${markdown.length}`);
                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                const variant = { id: i + 1, headings, markdown, summary: (summaryText || '').trim() };
                sendEvent('variant', { variant });
                // Send final authoritative headings snapshot, derived from markdown if present
                const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                if (finalHeadings.length) sendEvent('headings', { id: i + 1, items: finalHeadings.slice(0, 6) });
                try { clearInterval(variantHeartbeat); } catch(_) {}

            } catch (err) {
                const detail = (err && (err.response?.data?.error?.message || err.error?.message || err.message)) || 'Ukendt fejl';
                logDebug(`[summarize] OpenAI error in variant generation: ${detail}`);
                sendEvent('error', { id: i + 1, message: `Fejl ved generering af variant ${i + 1}`, error: detail, code: err?.code || null });
                // Ensure heartbeat stops on error
                try { clearInterval(variantHeartbeat); } catch(_) {}
                return;
            }
        });

        // Run sequentially or in parallel depending on env
        const parallel = String(process.env.SUMMARY_PARALLEL || process.env.PARALLEL_SUMMARY || 'true').toLowerCase();
        const shouldRunParallel = parallel !== 'false' && parallel !== '0' && parallel !== 'no';
        if (shouldRunParallel) {
            await Promise.all(tasks.map(t => t()));
        } else {
            for (const t of tasks) { await t(); }
        }
        
        sendEvent('end', { message: 'Færdig med at generere.' });
        res.end();
        
    } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || String(e);
        logDebug(`[summarize] Failed: ${msg}`);
        sendEvent('error', { message: `Serverfejl: ${msg}` });
        res.end();
    }
});

// Parse JSON bodies with tolerance to stray control chars: use express.text and sanitize
app.post('/api/summarize/:id', express.text({ type: 'application/json', limit: '25mb' }), async (req, res) => {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try { if (typeof req.setTimeout === 'function') req.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}
    try { if (typeof res.setTimeout === 'function') res.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}

    const t0 = performance.now();
    console.log(`[summarize] POST Request received for hearing ${req.params.id}`);

    // Parse raw JSON body (we used express.text to avoid interfering with SSE)
    let parsedBody = null;
    try {
        const raw = typeof req.body === 'string' ? req.body : (req.body ? String(req.body) : '');
        // Remove stray nulls/control chars that may appear from some clients
        const sanitized = raw.replace(/[\u0000-\u001F\u007F]/g, (c) => (c === '\n' || c === '\r' || c === '\t') ? c : '');
        parsedBody = JSON.parse(sanitized || '{}');
    } catch (_) {
        parsedBody = null;
    }

    // This handler returns a promise that resolves only when the entire SSE stream is finished.
    return new Promise((resolve, reject) => {
        const keepAliveInterval = setInterval(() => {
            try {
                if (!res.writableEnded) {
                    res.write('event: ping\ndata: {"time": ' + Date.now() + '}\n\n');
                } else {
                    clearInterval(keepAliveInterval);
                }
            } catch (e) {
                console.error('[summarize] Error in keep-alive ping:', e);
                clearInterval(keepAliveInterval);
            }
        }, 10000);

        const sendEvent = (eventName, data) => {
            if (!res.writableEnded) {
                res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };
        
        req.on('close', () => {
            try { clearInterval(keepAliveInterval); } catch (_) {}
            if (!res.writableEnded) {
                res.end();
                logDebug('[summarize] Client disconnected, closing SSE connection.');
            }
            resolve(); // Resolve the main promise on client disconnect
        });

        (async () => {
            try {
                // Sanitize and parse JSON if body arrived as text
                if (typeof req.body === 'string') {
                    let raw = req.body;
                    raw = raw.replace(/[\u0000-\u0019\u007F]/g, (ch) => (ch === '\n' || ch === '\r' || ch === '\t' ? ch : ' '));
                    try { req.body = JSON.parse(raw); }
                    catch (e) {
                        sendEvent('status', { phase: 'body', message: 'Body kunne ikke læses – fortsætter uden body…' });
                        req.body = {};
                    }
                }

                const DEMO2 = String(req.query.demo || '') === '1';
                if (DEMO2) {
                    const n = Number(req.query.n || 3);
                    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                    const demoDelay = Number(req.query.delay || process.env.DEMO_DELAY_MS || 400);
                    sendEvent('info', { message: `DEMO: Genererer ${n} varianter...`, hearing: (req.body && req.body.hearing) || undefined });
                    for (let i = 1; i <= n; i++) {
                        await sleep(demoDelay);
                        sendEvent('info', { message: `DEMO: Genererer variant ${i} af ${n}...` });
                        sendEvent('placeholder', { id: i });
                        await sleep(demoDelay);
                        sendEvent('status', { id: i, phase: 'started', message: 'Job startet…' });
                        const steps = [
                            'Identificerer gennemgående temaer',
                            'Vurderer prioritet: klima, trafik, byrum',
                            'Afklarer enighed/uenighed i indsigter',
                            'Matcher krav i materialet',
                            'Skitserer struktureret output'
                        ];
                        sendEvent('status', { id: i, phase: 'thinking', message: 'Modellen overvejer…' });
                        for (const s of steps) { await sleep(demoDelay); sendEvent('summary', { id: i, text: s }); }
                        await sleep(demoDelay);
                        sendEvent('status', { id: i, phase: 'drafting', message: 'Skriver udkast…' });
                        const markdown = `# Opsummering (DEMO ${i})\n\n## Klima\nFlere ønsker grønne tage.\n\n## Mobilitet\nCykelstier prioriteres.\n\n## Bykvalitet\nGrønne opholdszoner foreslås.`;
                        const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                        await sleep(demoDelay);
                        sendEvent('variant', { variant: { id: i, headings, markdown, summary: steps.join('\n') } });
                        await sleep(demoDelay);
                        sendEvent('status', { id: i, phase: 'done', message: 'Færdig' });
                    }
                    // extra small pause to ensure client digests last events before close
                    await sleep(50);
                    sendEvent('end', { message: 'Færdig med at generere (DEMO).' });
                    try { clearInterval(keepAliveInterval); } catch (_) {}
                    res.end();
                    return resolve();
                }
                const hearingId = String(req.params.id).trim();

                // In background mode, immediately create job and poll over SSE; accept optional body
                // Respect explicit bg=0 to force direct streaming and avoid DB inserts
                const bgParam2 = String(req.query.bg || '').trim().toLowerCase();
                const forceDirect2 = bgParam2 === '0' || bgParam2 === 'false' || bgParam2 === 'no';
                if (BACKGROUND_MODE && !forceDirect2) {
                    await legacySummarizeAsJobSse(req, res, {
                        hearing: parsedBody && parsedBody.hearing,
                        responses: parsedBody && parsedBody.responses,
                        materials: parsedBody && parsedBody.materials,
                        edits: parsedBody && parsedBody.edits,
                        n: Number(req.query.n || parsedBody?.n || DEFAULT_VARIANTS)
                    });
                    return resolve();
                }

                if (!openai) {
                    sendEvent('status', { phase: 'openai', message: 'OPENAI_API_KEY mangler – kører ikke OpenAI.' });
                    sendEvent('error', { message: 'Manglende OPENAI_API_KEY i miljøet. Tilføj nøglen og prøv igen.' });
                    return res.end();
                } else {
                    sendEvent('status', { phase: 'openai', message: 'Forbundet til OpenAI.' });
                }
                const providedResponsesMd = null;
                const providedMaterialMd = null;

                // Pre-show variant placeholders and per-variant status early to avoid client fallback
                try {
                    const nPlaceholders = Number(req.query.n || 3);
                    for (let i = 1; i <= nPlaceholders; i++) {
                        sendEvent('placeholder', { id: i });
                        sendEvent('status', { id: i, phase: 'preparing', message: 'Forbereder variant…' });
                    }
                } catch (_) {}

                // Check if data was provided in request body (optimized path)
                let hearing, responses, materials;
                
                if (parsedBody && parsedBody.hearing && parsedBody.responses && parsedBody.materials) {
                    // Validate provided data
                    if (!parsedBody.hearing.id || !parsedBody.hearing.title) {
                        sendEvent('error', { message: 'Ugyldig høringsdata' });
                        return res.end();
                    }
                    
                    // Use provided data - much faster!
                    sendEvent('info', { message: 'Forbereder dokumenter...' });
                    sendEvent('status', { phase: 'preparing', message: 'Forbereder materiale til prompt…' });
                    hearing = parsedBody.hearing;
                    responses = Array.isArray(parsedBody.responses) ? parsedBody.responses : [];
                    materials = Array.isArray(parsedBody.materials) ? parsedBody.materials : [];
                    // Apply minimal respondent overrides if provided separately in body.edits
                    try {
                        const overrides = req.body && req.body.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
                        if (overrides) {
                            responses = responses.map(r => {
                                const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                                const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                                if (!ov || typeof ov !== 'object') return r;
                                const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                                const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                                const patched = { ...r };
                                if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                                if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                                return patched;
                            });
                        }
                    } catch (_) {}
                    
                    // Ensure hearing ID matches URL parameter
                    if (String(hearing.id) !== hearingId) {
                        sendEvent('error', { message: 'Høring ID matcher ikke' });
                        return res.end();
                    }
                    
                    console.log(`[summarize] Using provided data from request body - optimized path. Responses: ${responses.length}, Materials: ${materials.length}`);
                } else {
                    // Fallback to fetching data via aggregated endpoint to reduce latency, with live ticker
                    sendEvent('info', { message: 'Henter høringsdata...' });
                    const nPlaceholders = Number(req.query.n || 3);
                    try {
                        for (let i = 1; i <= nPlaceholders; i++) {
                            sendEvent('placeholder', { id: i });
                            sendEvent('status', { id: i, phase: 'preparing', message: 'Forbereder variant…' });
                        }
                    } catch (_) {}
                    const base = `http://localhost:${PORT}`;
                    let secs = 0;
                    const ticker = setInterval(() => { secs += 2; try { sendEvent('info', { message: `Henter høringsdata… (${secs}s)` }); } catch {} }, 2000);
                    const metaResp = await axios.get(`${base}/api/hearing/${hearingId}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                    try { clearInterval(ticker); } catch(_) {}
                    if (!metaResp.data?.success) {
                        sendEvent('error', { message: 'Kunne ikke hente høringsmetadata' });
                        return res.end();
                    }
                    hearing = metaResp.data.hearing;
                    const responsesRaw = Array.isArray(metaResp.data?.responses) ? metaResp.data.responses : [];
                    materials = Array.isArray(metaResp.data?.materials) ? metaResp.data.materials : [];
                    // Apply minimal respondent overrides if provided in body.edits
                    try {
                        const overrides = req.body && req.body.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
                        if (overrides) {
                            responses = responsesRaw.map(r => {
                                const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                                const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                                if (!ov || typeof ov !== 'object') return r;
                                const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                                const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                                const patched = { ...r };
                                if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                                if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                                return patched;
                            });
                        } else {
                            responses = responsesRaw;
                        }
                    } catch (_) {
                        responses = responsesRaw;
                    }
                    sendEvent('info', { message: 'Forbereder dokumenter...' });
                }
                
                const t1 = performance.now();
                console.log(`[summarize] Data preparation took ${Math.round(t1 - t0)} ms.`);

                // Build prompt in-memory to avoid disk I/O latency on the hot path
                let repliesText;
                console.log(`[summarize] Starting prompt construction...`);
                sendEvent('status', { phase: 'preparing', message: `Forbereder høringssvar...` });

                if (providedResponsesMd) {
                    repliesText = providedResponsesMd;
                } else {
                    // Build JSON with the exact fields expected by the wizard/UX:
                    // svarnummer, svartekst, respondentnavn, respondenttype
                    const repliesObjects = responses.map(r => ({
                        svarnummer: (r && (r.svarnummer ?? r.id)) ?? null,
                        svartekst: (r && (r.svartekst ?? r.text ?? '')) || '',
                        respondentnavn: (r && (r.respondentnavn ?? r.respondentName ?? r.author ?? '')) || '',
                        respondenttype: (r && (r.respondenttype ?? r.respondentType ?? 'Borger')) || 'Borger'
                    }));
                    repliesText = JSON.stringify(repliesObjects, null, 2);
                }
                
                const t2 = performance.now();
                console.log(`[summarize] Response JSON construction took ${Math.round(t2 - t1)} ms.`);
                sendEvent('status', { phase: 'preparing', message: `Forbereder materialer...` });

                let materialText;
                if (providedMaterialMd) {
                    materialText = providedMaterialMd;
                } else {
                    const materialLines = [];
                    materialLines.push(`# Høringsmateriale for ${hearing.title}`);
                    for (let i = 0; i < materials.length; i++) {
                        const m = materials[i] || {};
                        // Support both legacy server-extracted shape { type, title, url/content }
                        // and new client-provided shape { kind: 'text'|'file'|'link', ... }
                        const kind = m.kind || m.type;
                        try {
                            if ((kind === 'description' || kind === 'text') && m.content) {
                                materialLines.push('');
                                materialLines.push(String(m.content));
                                materialLines.push('');
                            } else if (kind === 'file') {
                                if (m.data && (m.mime || m.filename)) {
                                    // Client provided base64 file data. Persist to tmp and extract text when possible
                                    try {
                                        const buf = Buffer.from(String(m.data), 'base64');
                                        let ext = '';
                                        try {
                                            const lowerMime = String(m.mime || '').toLowerCase();
                                            if (lowerMime.includes('pdf')) ext = '.pdf';
                                            else if (lowerMime.includes('wordprocessingml')) ext = '.docx';
                                            else if (lowerMime.includes('msword')) ext = '.doc';
                                            else if (lowerMime.includes('text')) ext = '.txt';
                                            else if (lowerMime.includes('html')) ext = '.html';
                                        } catch (_) {}
                                        if (!ext && m.filename) {
                                            try { const p = String(m.filename); const maybe = '.' + (p.split('.').pop() || ''); if (maybe.length <= 6) ext = maybe; } catch (_) {}
                                        }
                                        const tmpPath = path.join(ensureTmpDir(), `material_${Date.now()}_${i}${ext || ''}`);
                                        fs.writeFileSync(tmpPath, buf);
                                        let extracted = '';
                                        try { extracted = await extractTextFromLocalFile(tmpPath); } catch (_) {}
                                        if (extracted && extracted.trim()) {
                                            materialLines.push('');
                                            materialLines.push(`## ${m.title || m.filename || 'Dokument'}`);
                                            materialLines.push(extracted);
                                            materialLines.push('');
                                        } else {
                                            // If no text could be extracted, just record its presence
                                            materialLines.push(`- ${m.title || m.filename || 'Dokument'} [indlejret fil, ${buf.length} bytes]`);
                                        }
                                    } catch (_) {
                                        materialLines.push(`- ${m.title || m.filename || 'Dokument'} [kunne ikke læses]`);
                                    }
                                } else if (m.url) {
                                    // No data provided; try to fetch and extract text from the URL server-side
                                    try {
                                        const base = `http://localhost:${PORT}`;
                                        const url = m.url.startsWith('/api/file-proxy') ? `${base}${m.url}` : `${base}/api/file-proxy?${new URLSearchParams({ path: m.url, filename: m.title || 'Dokument' }).toString()}`;
                                        const dl = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true, timeout: 45000, headers: { 'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8' } });
                                        if (dl && dl.status === 200 && dl.data) {
                                            const buf2 = Buffer.from(dl.data);
                                            let ext2 = '';
                                            try {
                                                const ctype = String(dl.headers['content-type'] || '').toLowerCase();
                                                if (ctype.includes('pdf')) ext2 = '.pdf';
                                                else if (ctype.includes('wordprocessingml')) ext2 = '.docx';
                                                else if (ctype.includes('msword')) ext2 = '.doc';
                                                else if (ctype.includes('text')) ext2 = '.txt';
                                                else if (ctype.includes('html')) ext2 = '.html';
                                            } catch (_) {}
                                            if (!ext2 && m.title) {
                                                try { const p = String(m.title); const maybe = '.' + (p.split('.').pop() || ''); if (maybe.length <= 6) ext2 = maybe; } catch (_) {}
                                            }
                                            const tmp2 = path.join(ensureTmpDir(), `material_${Date.now()}_${i}${ext2 || ''}`);
                                            fs.writeFileSync(tmp2, buf2);
                                            let extracted2 = '';
                                            try { extracted2 = await extractTextFromLocalFile(tmp2); } catch (_) {}
                                            if (extracted2 && extracted2.trim()) {
                                                materialLines.push('');
                                                materialLines.push(`## ${m.title || 'Dokument'}`);
                                                materialLines.push(extracted2);
                                                materialLines.push('');
                                            } else {
                                                materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                                            }
                                        } else {
                                            materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                                        }
                                    } catch (_) {
                                        materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                                    }
                                }
                            } else if (kind === 'link' && m.url) {
                                materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                            } else if (m.url && !kind) {
                                // Fallback: unknown kind but has URL
                                materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                            }
                        } catch (_) {}
                        if (i > 0 && i % 5 === 0) {
                            sendEvent('status', { phase: 'preparing', message: `Forbereder materialer (${i}/${materials.length})...` });
                            await new Promise(resolve => setImmediate(resolve));
                        }
                    }
                    materialText = materialLines.join('\n');
                }

                const t3 = performance.now();
                console.log(`[summarize] Material construction took ${Math.round(t3 - t2)} ms.`);

                const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
                const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
                const RESP_LIMIT = Number(process.env.RESP_CHAR_LIMIT || 200000);
                const MAT_LIMIT = Number(process.env.MAT_CHAR_LIMIT || 120000);
                const userPrompt = `${promptTemplate}\n\n[Samlede Høringssvar]\n\n${String(repliesText || '').slice(0, RESP_LIMIT)}\n\n[Høringsmateriale]\n\n${String(materialText || '').slice(0, MAT_LIMIT)}`;
                
                const t4 = performance.now();
                console.log(`[summarize] Total prompt construction took ${Math.round(t4 - t1)} ms. Prompt length: ${userPrompt.length}`);

                logDebug(`[summarize] Constructed user prompt of length ${userPrompt.length}.`);

                if (userPrompt.length < 200) { // Arbitrary small length check
                    sendEvent('error', { message: 'Fejl: Kunne ikke generere prompt. For lidt data at arbejde med.'});
                    res.end();
                    return resolve();
                }

                const n = Number(req.query.n || 3);
                sendEvent('info', { message: `Genererer ${n} varianter...`, hearing });
                sendEvent('status', { phase: 'queueing', message: `Starter ${n} varianter…` });

                const model = MODEL_ID;
                const maxTokens = MAX_TOKENS;

                // Compute fast pre-thoughts for POST path too
                const preThoughts2 = computePreThoughts(userPrompt);

                function extractHeadingsFromSummary2(text) {
                    try {
                        const raw = String(text || '').replace(/\r/g, '');
                        const byLine = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
                        const bullets = byLine
                            .filter(l => /^[-*••]|^\d+\./.test(l) || (l.length <= 120 && /[:–-]/.test(l)))
                            .map(l => l.replace(/^[-*•\d+.\s]+/, '').trim());
                        const unique = [];
                        const seen = new Set();
                        for (const b of bullets) { if (!seen.has(b)) { seen.add(b); unique.push(b); } }
                        return unique.slice(-6);
                    } catch { return []; }
                }

                const runSummarizeTasks = () => {
                    return new Promise((resolveTasks, rejectTasks) => {
                        // Force background jobs in POST pathway to avoid long-lived direct stream stalls
                        const useBackground = true;

                        const tasks = Array.from({ length: n }, (_, i) => {
                            const variantId = i + 1;
                            
                            return (async () => {
                                let stream;
                                let markdown = '';
                                let summaryText = '';
                                let poller;
                                let lastReportedLen = 0;
                                let gotFirstDelta = false;
                                let gotReasoningDelta = false;
                                let variantHeartbeat;

                                try {
                                    sendEvent('status', { id: variantId, phase: 'preparing', message: 'Registrerer job…' });
                                    
                                    const params = {
                                        model,
                                        input: [
                                            { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
                                            { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                                        ],
                                    };
                                    // Attach options for reasoning-capable models similar to GET path
                                    try {
                                        const supportsReasoning = /^(gpt-5|o3|o4)/i.test(model);
                                        if (Number.isFinite(maxTokens) && maxTokens > 0) params.max_output_tokens = maxTokens;
                                        if (/^gpt-5/i.test(model)) {
                                            // optional verbosity
                                            if (VERBOSITY_ENV) params.text = { ...(params.text || {}), verbosity: VERBOSITY_ENV };
                                        }
                                        if (supportsReasoning && REASONING_EFFORT_ENV) {
                                            params.reasoning = { ...(params.reasoning || {}), effort: REASONING_EFFORT_ENV };
                                        }
                                    } catch (_) {}

                                    if (useBackground) {
                                        params.stream = false;
                                        params.background = true;
                                        
                                        logDebug(`[summarize] Variant ${variantId}: Creating background job.`);
                                        sendEvent('status', { id: variantId, phase: 'creating_job', message: 'Opretter job hos OpenAI...' });
                                        const created = await openai.responses.create(params);
                                        const responseId = created && (created.id || created.response_id || created.response?.id);
                                        if (!responseId) throw new Error('Could not get response ID for background job.');
                                        
                                        logDebug(`[summarize] Variant ${variantId}: Job created with ID ${responseId}. Starting polling.`);
                                        sendEvent('status', { id: variantId, phase: 'queued', message: 'Job i kø, afventer start...' });

                                        await new Promise((resolvePoll, rejectPoll) => {
                                            let pollCount = 0;
                                            // 25 minutes @ 5s interval = 300 polls
                                            const maxPolls = Number.isFinite(SUMMARIZE_TIMEOUT_MS) ? Math.ceil(SUMMARIZE_TIMEOUT_MS / 5000) : 300;
                                            poller = setInterval(async () => {
                                                try {
                                                    if (res.writableEnded === false && pollCount++ > maxPolls) {
                                                        return rejectPoll(new Error('Polling timeout: Job took too long.'));
                                                    }
                                                    if (res.writableEnded) {
                                                        return resolvePoll();
                                                    }
                                                    
                                                    const job = await openai.responses.retrieve(responseId);
                                                    const status = String(job?.status || 'unknown').toLowerCase();
                                                    
                                                    logDebug(`[summarize] Variant ${variantId}: Poll count ${pollCount}, status: ${status}`);
                                                    sendEvent('status', { id: variantId, phase: 'polling', message: `Jobstatus: ${status}...` });

                                                    if (['completed', 'succeeded', 'done'].includes(status)) {
                                                        resolvePoll();
                                                    } else if (['failed', 'cancelled', 'error'].includes(status)) {
                                                        rejectPoll(new Error(`Job failed with status: ${status}`));
                                                    }
                                                } catch (pollErr) {
                                                    rejectPoll(pollErr);
                                                }
                                            }, 5000);
                                        }).finally(() => {
                                            clearInterval(poller);
                                        });

                                        logDebug(`[summarize] Variant ${variantId}: Polling complete. Streaming results.`);
                                        sendEvent('status', { id: variantId, phase: 'streaming', message: 'Job færdigt, henter resultater...' });
                                        stream = await openai.responses.stream({ response_id: responseId });

                                    } else {
                                        params.stream = true;
                                        logDebug(`[summarize] Variant ${variantId}: Starting direct stream...`);
                                        sendEvent('status', { id: variantId, phase: 'connecting', message: 'Opretter direkte stream…' });
                                        stream = await openai.responses.stream(params);
                                    }

                                    // Per-variant liveness indicator
                                    const startedAtMs = Date.now();
                                    variantHeartbeat = setInterval(() => {
                                        try {
                                            if (res.writableEnded) { clearInterval(variantHeartbeat); return; }
                                            const secs = Math.round((Date.now() - startedAtMs) / 1000);
                                            if (!gotFirstDelta && !gotReasoningDelta) {
                                                sendEvent('status', { id: variantId, phase: 'connecting', message: `Tænker (${secs}s)` });
                                            } else if (gotReasoningDelta && !gotFirstDelta) {
                                                sendEvent('status', { id: variantId, phase: 'thinking', message: `Modellen overvejer… (${secs}s)` });
                                            } else if (gotFirstDelta) {
                                                sendEvent('status', { id: variantId, phase: 'drafting', message: `Skriver udkast… (${secs}s)` });
                                            }
                                        } catch (_) {}
                                    }, 5000);

                                    // Stream loop with partial flush of content/headings
                                    const seenHeadings = new Set();
                                    for await (const event of stream) {
                                        if (event && typeof event.type === 'string') {
                                            if (event.type === 'response.created') {
                                                sendEvent('status', { id: variantId, phase: 'started', message: 'Job startet…' });
                                            } else if (event.type.startsWith('response.tool_')) {
                                                sendEvent('status', { id: variantId, phase: 'using-tools', message: 'Kalder værktøjer…' });
                                            } else if (event.type === 'response.completed') {
                                                sendEvent('status', { id: variantId, phase: 'done', message: 'Færdig' });
                                            }
                                        }

                                        if (event.type === 'response.output_text.delta') {
                                            markdown += (event.delta || '');
                                            if (!gotFirstDelta) {
                                                gotFirstDelta = true;
                                                sendEvent('status', { id: variantId, phase: 'drafting', message: 'Skriver udkast…' });
                                            }
                                            if (markdown.length - lastReportedLen >= 200) {
                                                const tmpHeadings = (markdown.match(/^#{1,6} .*$/mg) || []);
                                                const newOnes = [];
                                                for (const h of tmpHeadings) {
                                                    if (!seenHeadings.has(h)) { seenHeadings.add(h); newOnes.push(h.replace(/^#{1,6}\s*/, '')); }
                                                }
                                                if (newOnes.length) sendEvent('headings', { id: variantId, items: Array.from(new Set(newOnes)).slice(-6) });
                                                sendEvent('content', { id: variantId, markdown });
                                                lastReportedLen = markdown.length;
                                            }
                                        } else if (event.type === 'response.reasoning_summary.delta' || event.type === 'response.reasoning_summary_text.delta') {
                                            const delta = (typeof event.delta === 'string') ? event.delta : (event.delta?.toString?.() || '');
                                            summaryText += (delta || '');
                                            if (!gotReasoningDelta) {
                                                gotReasoningDelta = true;
                                                sendEvent('status', { id: variantId, phase: 'thinking', message: 'Modellen overvejer…' });
                                            }
                                        } else if (event.type === 'response.reasoning_summary.done' || event.type === 'response.reasoning_summary_text.done') {
                                            if (event.text) summaryText = event.text;
                                        } else if (event.type === 'response.error') {
                                            throw new Error(event.error?.message || 'OpenAI stream error');
                                        }
                                    }

                                    // Fallback to non-streaming if nothing arrived
                                    if (!markdown) {
                                        try {
                                            const nonStreamParams = { model, input: params.input, stream: false };
                                            if (Number.isFinite(maxTokens) && maxTokens > 0) nonStreamParams.max_output_tokens = maxTokens;
                                            const resp = await openai.responses.create(nonStreamParams);
                                            let text = '';
                                            if (resp) {
                                                if (typeof resp.output_text === 'string') text = resp.output_text;
                                                else if (Array.isArray(resp.output_text)) text = resp.output_text.join('\n');
                                                else if (Array.isArray(resp.output)) {
                                                    try { text = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n'); } catch (_) {}
                                                }
                                            }
                                            markdown = (text || '').trim();
                                        } catch (e) {
                                            // ignore; handled below
                                        }
                                    }

                                    if (!markdown) throw new Error('Empty response from OpenAI');

                                    const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                    const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                    sendEvent('variant', { variant });
                                    const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                    if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });

                                } catch (err) {
                                    const detail = (err && (err.response?.data?.error?.message || err.error?.message || err.message)) || 'Ukendt fejl';
                                    logDebug(`[summarize] Variant ${variantId} failed: ${detail}`);
                                    sendEvent('error', { id: variantId, message: `Fejl i variant ${variantId}`, error: detail });
                                } finally {
                                    if (poller) clearInterval(poller);
                                    if (variantHeartbeat) clearInterval(variantHeartbeat);
                                    sendEvent('status', { id: variantId, phase: 'done', message: 'Færdig' });
                                }
                            })();
                        });

                        Promise.all(tasks).then(resolveTasks).catch(rejectTasks);
                    });
                };
                
                await runSummarizeTasks();
                
                sendEvent('end', { message: 'Færdig med at generere.' });
                res.end();
                resolve(); // Resolve the main promise
            } catch (e) {
                logDebug(`[summarize] Failed: ${e?.message || e}`);
                if (!res.writableEnded) {
                    sendEvent('error', { message: 'Fejl ved opsummering', error: e.message });
                    res.end();
                }
                reject(e); // Reject the main promise on error
            } finally {
                clearInterval(keepAliveInterval);
            }
        })();
    });
});

// Build DOCX using Python tool from gpt5-webapp
app.post('/api/build-docx', express.json({ limit: '5mb' }), async (req, res) => {
    try {
        const { markdown, outFileName } = req.body || {};
        if (typeof markdown !== 'string' || !markdown.trim()) {
            return res.status(400).json({ success: false, message: 'Missing markdown' });
        }
        const tmpDir = ensureTmpDir();
        const outPath = path.join(tmpDir, `${outFileName || 'output'}.docx`);
        // Prefer Python path
        const python = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, 'scripts', 'build_docx.py');
        const templateDocxPath = TEMPLATE_DOCX;
        const templateBlockPath = path.join(__dirname, 'templates', 'blok.md');
        const runPython = async () => new Promise((resolve, reject) => {
            try {
                const child = spawn(python, [
                    scriptPath,
                    '--markdown', '-',
                    '--out', outPath,
                    '--template', templateDocxPath,
                    '--template-block', templateBlockPath
                ], { stdio: ['pipe', 'pipe', 'pipe'] });
                let stderr = '';
                child.stdin.write(markdown);
                child.stdin.end();
                child.stderr.on('data', d => { stderr += d.toString(); });
                child.on('error', err => reject(err));
                child.on('close', code => code === 0 ? resolve(null) : reject(new Error(stderr || `exit ${code}`)));
            } catch (e) { reject(e); }
        });
        try {
            await runPython();
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
            return fs.createReadStream(outPath).pipe(res);
        } catch (pyErr) {
            return res.status(500).json({ success: false, message: 'DOCX bygning fejlede', error: String(pyErr && pyErr.message || pyErr) });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved DOCX bygning', error: e.message });
    }
});

// Test endpoint: build DOCX from bundled scriptskabelon/testOutputLLM.md
app.get('/api/test-docx', async (req, res) => {
    try {
        const samplePath = path.join(__dirname, 'templates', 'testOutputLLM.md');
        if (!fs.existsSync(samplePath)) {
            return res.status(404).json({ success: false, message: 'Prøvedata ikke fundet' });
        }
        const markdown = fs.readFileSync(samplePath, 'utf8');
        const tmpDir = ensureTmpDir();
        const outPath = path.join(tmpDir, `test_${Date.now()}.docx`);

        const python = process.env.PYTHON_BIN || 'python3';
        // Use the Colab-aligned builder for test route as well
        const scriptPath = path.join(__dirname, 'scripts', 'build_docx.py');
        const templateDocxPath = TEMPLATE_DOCX;
        const templateBlockPath = path.join(__dirname, 'templates', 'blok.md');
        const args = [
            scriptPath,
            '--markdown', '-',
            '--out', outPath,
            '--template', templateDocxPath,
            '--template-block', templateBlockPath
        ];
        const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stdin.write(markdown);
        child.stdin.end();
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', (code) => {
            if (code !== 0) {
                return res.status(500).json({ success: false, message: 'DOCX bygning fejlede', error: stderr || `exit ${code}` });
            }
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', 'attachment; filename="test_output.docx"');
            fs.createReadStream(outPath).pipe(res);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved test-DOCX', error: e.message });
    }
});

// Simple backend debug view to inspect API output without a frontend
app.get('/debug/hearing/:id', async (req, res) => {
    try {
        const apiUrl = `/api/hearing/${encodeURIComponent(req.params.id)}`;
        // Call our own API internally
        const localUrl = `http://localhost:${PORT}${apiUrl}`;
        const r = await axios.get(localUrl, { validateStatus: () => true });
        const payload = r.data || {};
        const html = `
            <!doctype html>
            <html lang="da">
            <head>
                <meta charset="utf-8" />
                <title>Debug: Høringssvar ${req.params.id}</title>
                <style>
                    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 20px; }
                    h1 { font-weight: 400; }
                    .meta { background:#eef6ff; padding:12px; border-left:4px solid #1e88e5; margin:16px 0; }
                    .resp { border:1px solid #eee; border-radius:8px; padding:12px; margin:12px 0; }
                    .atts a { display:block; margin:2px 0; color:#1e88e5; text-decoration:none; }
                    code, pre { background:#f8f9fa; padding: 8px; border-radius: 6px; display:block; overflow:auto; }
                </style>
            </head>
            <body>
                <h1>Debug: Høringssvar ${req.params.id}</h1>
                <div class="meta">
                    <div><strong>ID:</strong> ${payload?.hearing?.id ?? ''}</div>
                    <div><strong>Titel:</strong> ${payload?.hearing?.title ?? ''}</div>
                    <div><strong>Status:</strong> ${payload?.hearing?.status ?? ''}</div>
                    <div><strong>Start:</strong> ${payload?.hearing?.startDate ?? ''}</div>
                    <div><strong>Frist:</strong> ${payload?.hearing?.deadline ?? ''}</div>
                    <div><strong>URL:</strong> <a href="${payload?.hearing?.url ?? '#'}" target="_blank">${payload?.hearing?.url ?? ''}</a></div>
                    <div><strong>Antal svar:</strong> ${payload?.totalResponses ?? 0}</div>
                </div>
                ${(payload?.responses || []).map(r => `
                    <div class="resp">
                        <div><strong>Svarnummer:</strong> ${r.id}</div>
                        ${r.submittedAt ? `<div><strong>Dato:</strong> ${r.submittedAt}</div>` : ''}
                        ${r.author || r.organization ? `<div><strong>Forfatter/Org.:</strong> ${(r.author||'') + (r.organization? ' – '+r.organization : '')}</div>` : ''}
                        ${r.onBehalfOf ? `<div><strong>På vegne af:</strong> ${r.onBehalfOf}</div>` : ''}
                        ${r.authorAddress ? `<div><strong>Adresse:</strong> ${r.authorAddress}</div>` : ''}
                        <div style="margin-top:8px; white-space:pre-wrap">${(r.text||'').replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}</div>
                        ${Array.isArray(r.attachments) && r.attachments.length ? `<div class="atts" style="margin-top:8px;"><strong>Bilag:</strong>${r.attachments.map(a => `<a href="${a.url}" target="_blank">📄 ${a.filename}</a>`).join('')}</div>` : ''}
                    </div>
                `).join('')}
                <h3>Rå JSON</h3>
                <pre>${JSON.stringify(payload, null, 2).replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}</pre>
            </body>
            </html>
        `;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        res.status(500).send(`<pre>Fejl: ${error.message}</pre>`);
    }
});

// Accept client-side logs to surface errors in Render logs
app.post('/api/client-log', express.json({ limit: '256kb' }), (req, res) => {
    try {
        const { level = 'info', message = '', meta = {} } = req.body || {};
        const line = `[client] ${level}: ${message} ${Object.keys(meta||{}).length ? JSON.stringify(meta) : ''}`;
        logDebug(line);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Health endpoints for Render
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// Prefetch and persist all data for a hearing (meta+responses+materials) to disk
app.post('/api/prefetch/:id', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        const [agg, resps, mats] = await Promise.all([
            axios.get(`${base}/api/hearing/${hearingId}?nocache=1`, { validateStatus: () => true }),
            axios.get(`${base}/api/hearing/${hearingId}/responses?nocache=1`, { validateStatus: () => true }),
            axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true })
        ]);
        let payload = null;
        if (agg.status === 200 && agg.data && agg.data.success) payload = agg.data;
        else if (resps.status === 200 && mats.status === 200 && resps.data && mats.data) {
            payload = {
                success: true,
                hearing: { id: Number(hearingId) },
                responses: Array.isArray(resps.data.responses) ? resps.data.responses : [],
                materials: Array.isArray(mats.data.materials) ? mats.data.materials : []
            };
        }
        if (!payload) return res.status(500).json({ success: false, message: 'Kunne ikke hente data' });
        writePersistedHearing(hearingId, payload);
        res.json({ success: true, message: 'Prefetch gemt', counts: { responses: payload.responses?.length || 0, materials: payload.materials?.length || 0 } });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Prefetch-fejl', error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Warm search index after server is listening
    loadIndexFromDisk();
    warmHearingIndex().catch((err) => {
        console.error('Error warming hearing index on startup:', err.message);
    });
    // Optional: warm all hearings + materials upfront to avoid user waits
    if (WARM_ALL_ON_START) {
        (async () => {
            try {
                const items = Array.isArray(hearingIndex) ? hearingIndex.slice() : [];
                const max = Number.isFinite(WARM_MAX_HEARINGS) && WARM_MAX_HEARINGS > 0 ? Math.min(items.length, WARM_MAX_HEARINGS) : items.length;
                const queue = items.slice(0, max).map(h => h.id).filter(id => Number.isFinite(id));
                let active = 0;
                let idx = 0;
                const next = async () => {
                    if (idx >= queue.length) return;
                    const id = queue[idx++];
                    active++;
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                    const fetchOnce = async () => {
                        try { await axios.get(`${base}/api/hearing/${id}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }); } catch {}
                        try { await axios.get(`${base}/api/hearing/${id}/materials?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }); } catch {}
                    };
                    let attempts = 0;
                    while (attempts < WARM_RETRY_ATTEMPTS) { attempts++; await fetchOnce(); }
                    active--;
                    if (idx < queue.length) next();
                };
                for (let i = 0; i < Math.min(WARM_CONCURRENCY, queue.length); i++) next();
            } catch (e) {
                console.warn('Warm all on start failed:', e.message);
            }
        })();
    }
    // Periodic refresh to keep index robust
    const refreshMs = Number(process.env.INDEX_REFRESH_MS || (6 * 60 * 60 * 1000));
    if (Number.isFinite(refreshMs) && refreshMs > 0) {
        setInterval(() => {
            warmHearingIndex().catch((err) => {
                console.error('Error warming hearing index on interval:', err.message);
            });
        }, refreshMs);
    }

    // Optional cron-based jobs controlled via env
    if ((process.env.CRON_ENABLED || '1') !== '0') {
        try {
            const indexSpec = process.env.CRON_INDEX_SCHEDULE || '0 */6 * * *';
            cron.schedule(indexSpec, () => {
                warmHearingIndex().catch(() => {});
            });
            const refreshSpec = process.env.CRON_HEARING_REFRESH || '*/30 * * * *';
            cron.schedule(refreshSpec, async () => {
                try {
                    const cutoff = Date.now() - Number(process.env.REFRESH_STALE_MS || 24*60*60*1000);
                    if (sqliteDb) {
                        const rows = sqliteDb.prepare(`SELECT id FROM hearings WHERE updated_at IS NULL OR updated_at < ? LIMIT 50`).all(cutoff);
                        for (const row of rows) {
                            try { await axios.get(`http://localhost:${PORT}/api/hearing/${row.id}?nocache=1`); } catch {}
                            try { await axios.get(`http://localhost:${PORT}/api/hearing/${row.id}/materials?nocache=1`); } catch {}
                        }
                    }
                } catch {}
            });

            // Jobs cleanup
            const jobCleanupSpec = process.env.CRON_JOBS_CLEANUP || '12 * * * *';
            cron.schedule(jobCleanupSpec, () => {
                try { cleanupOldJobs(); } catch {}
            });
        } catch (e) {
            console.warn('Cron setup failed:', e.message);
        }
    }

    // Resume any dangling jobs from previous run
    try { resumeDanglingJobs(); } catch (e) { console.warn('resumeDanglingJobs failed:', e.message); }
});