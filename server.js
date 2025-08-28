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
let DocxLib = null;
try { DocxLib = require('docx'); } catch (_) { DocxLib = null; }
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
let SQLiteStore;
try { SQLiteStore = require('connect-sqlite3')(session); }
catch (_) { SQLiteStore = null; }
const cron = require('node-cron');
const { init: initDb, db: sqliteDb, upsertHearing, replaceResponses, replaceMaterials, readAggregate, getSessionEdits, upsertSessionEdit, setMaterialFlag, getMaterialFlags, addUpload, listUploads, markHearingComplete, isHearingComplete, setHearingArchived, listHearingsByStatusLike, listAllHearingIds } = require('./db/sqlite');

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
// Open-hearings refresh configuration (only target 'Afventer konklusion')
const REFRESH_TARGET_STATUSES = (process.env.REFRESH_TARGET_STATUSES || 'Afventer konklusion')
    .split(',')
    .map(s => s.trim())
    .map(s => s.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, ''))
    .map(s => s.toLowerCase())
    .filter(Boolean);
const REFRESH_MAX_ATTEMPTS = Math.max(1, Number(process.env.REFRESH_MAX_ATTEMPTS || 6));
const REFRESH_STABLE_REPEATS = Math.max(1, Number(process.env.REFRESH_STABLE_REPEATS || 2));
const REFRESH_CONCURRENCY = Math.max(1, Number(process.env.REFRESH_CONCURRENCY || 2));
// Node HTTP server timeouts (tuned for SSE and long background jobs). Defaults chosen to avoid premature disconnects
const SERVER_KEEP_ALIVE_TIMEOUT_MS = Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 65000);
const SERVER_HEADERS_TIMEOUT_MS = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 66000);
const SERVER_REQUEST_TIMEOUT_MS = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 0); // 0 disables request timeout
const WARM_CONCURRENCY = Math.max(1, Number(process.env.WARM_CONCURRENCY || 2));
const WARM_MAX_HEARINGS = Number(process.env.WARM_MAX_HEARINGS || 0); // 0 = no limit
const WARM_RETRY_ATTEMPTS = Math.max(1, Number(process.env.WARM_RETRY_ATTEMPTS || 2));
// Prefer API-only prefetcher (avoids heavy HTML scraping) for cron/warm paths
const API_ONLY_PREFETCH = parseBoolean(process.env.API_ONLY_PREFETCH || 'true');
const WARM_MIN_INTERVAL_MS = Math.max(0, Number(process.env.WARM_MIN_INTERVAL_MS || 120000));
const PREFETCH_CONCURRENCY = Math.max(1, Number(process.env.PREFETCH_CONCURRENCY || 2));
const PREFETCH_MIN_INTERVAL_MS = Math.max(0, Number(process.env.PREFETCH_MIN_INTERVAL_MS || 10*60*1000));

// In-memory guards to avoid thrashing
const lastWarmAt = new Map(); // hearingId -> ts
const prefetchInFlight = new Set(); // hearingId currently prefetching

// Render API configuration (for one-off jobs)
const RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_TOKEN || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || process.env.RENDER_SERVICE || '';
const RENDER_API_BASE = (process.env.RENDER_API_BASE || 'https://api.render.com').replace(/\/$/, '');
// Background mode default
function parseBoolean(value) {
    const v = String(value || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}
const OPENAI_BACKGROUND_DEFAULT = parseBoolean(process.env.OPENAI_BACKGROUND || process.env.BACKGROUND_MODE || process.env['BACKGROUND-MODE'] || 'false');
const BACKGROUND_MODE = parseBoolean(process.env.BACKGROUND_MODE || 'true');

// In-memory recent variants cache for salvage when clients disconnect from SSE
const RECENT_CACHE_LIMIT = 50; // total variants across all hearings
const recentVariantsByHearing = new Map(); // key: hearingId -> Map(variantId -> variant)
function recordRecentVariant(hearingId, variant) {
    try {
        const hid = String(hearingId || '').trim();
        if (!hid || !variant || !variant.id) return;
        if (!recentVariantsByHearing.has(hid)) recentVariantsByHearing.set(hid, new Map());
        const map = recentVariantsByHearing.get(hid);
        map.set(String(variant.id), {
            id: variant.id,
            markdown: variant.markdown || '',
            summary: variant.summary || '',
            headings: Array.isArray(variant.headings) ? variant.headings : []
        });
        // Prune global size
        let total = 0;
        for (const m of recentVariantsByHearing.values()) total += m.size;
        if (total > RECENT_CACHE_LIMIT) {
            // Remove oldest hearing entry (arbitrary: first inserted)
            const firstKey = recentVariantsByHearing.keys().next().value;
            if (typeof firstKey !== 'undefined') recentVariantsByHearing.delete(firstKey);
        }
    } catch {}
}

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

// Minimal Node.js fallback DOCX builder (used if Python builder fails)
async function buildDocxFallbackNode(markdown, outPath) {
    try {
        if (!DocxLib) return false;
        const { Document, Packer, Paragraph, HeadingLevel } = DocxLib;
        const doc = new Document({
            sections: [{ properties: {}, children: [] }]
        });
        const children = [];
        const lines = String(markdown || '').split(/\r?\n/);
        for (const raw of lines) {
            const line = String(raw || '');
            const m = line.match(/^(#{1,6})\s+(.*)$/);
            if (m) {
                const level = Math.min(Math.max(m[1].length, 1), 6);
                const text = m[2] || '';
                const headingMap = {
                    1: HeadingLevel.HEADING_1,
                    2: HeadingLevel.HEADING_2,
                    3: HeadingLevel.HEADING_3,
                    4: HeadingLevel.HEADING_4,
                    5: HeadingLevel.HEADING_5,
                    6: HeadingLevel.HEADING_6
                };
                children.push(new Paragraph({ text, heading: headingMap[level] }));
            } else if (line.trim().length === 0) {
                children.push(new Paragraph({ text: '' }));
            } else {
                // Strip basic markdown formatting for readability
                let text = line
                    .replace(/```[\s\S]*?```/g, '')
                    .replace(/^#{1,6}\s+/g, '')
                    .replace(/\*\*([^*]+)\*\*/g, '$1')
                    .replace(/\*([^*]+)\*/g, '$1')
                    .replace(/_([^_]+)_/g, '$1')
                    .replace(/\[(.*?)\]\([^)]*\)/g, '$1');
                children.push(new Paragraph({ text }));
            }
        }
        doc.addSection({ properties: {}, children });
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(outPath, buffer);
        return true;
    } catch (_) {
        return false;
    }
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
console.log('[Server] Starting SQLite initialization...');
console.log('[Server] Current directory:', __dirname);
console.log('[Server] Data directory:', path.join(__dirname, 'data'));
try { 
    initDb(); 
    // Prime a trivial statement to ensure better-sqlite3 loads and DB file is touchable
    const sqlite = require('./db/sqlite');
    try { if (sqlite && sqlite.db && sqlite.db.prepare) sqlite.db.prepare('SELECT 1').get(); } catch {}
    console.log('[Server] SQLite initialized successfully');
} catch (e) { 
    console.error('[Server] SQLite init failed:', e.message);
    console.error('[Server] Full error:', e);
}
app.use(session({
    store: SQLiteStore ? (SQLiteStore.length === 1
        ? new SQLiteStore({ 
            db: (process.env.SESSION_DB || 'sessions.sqlite'), 
            dir: process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, 'data') 
          })
        : new SQLiteStore({ client: sqliteDb, cleanupInterval: 900000 })) : undefined,
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

// Ensure Python deps (python-docx, lxml) are available at runtime
let pythonDepsReadyPromise = null;
function ensurePythonDeps() {
    if (pythonDepsReadyPromise) return pythonDepsReadyPromise;
    pythonDepsReadyPromise = new Promise((resolve) => {
        const python = process.env.PYTHON_BIN || 'python3';
        const localPy = path.join(__dirname, 'python_packages');
        const mergedPyPath = [localPy, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const env = { ...process.env, PYTHONPATH: mergedPyPath };
        const testCmd = [ '-c', 'import sys; sys.path.insert(0, "' + localPy.replace(/"/g, '\\"') + '"); import docx; from lxml import etree; print("ok")' ];
        try {
            const test = spawn(python, testCmd, { stdio: ['ignore','pipe','pipe'], env });
            let out = '';
            let err = '';
            test.stdout.on('data', d => { out += d.toString(); });
            test.stderr.on('data', d => { err += d.toString(); });
            test.on('close', (code) => {
                if (code === 0 && /ok/.test(out)) {
                    resolve(true);
                } else {
                    // Attempt runtime install using pinned requirements
                    const reqPath = path.join(__dirname, 'requirements.txt');
                    const target = path.join(__dirname, 'python_packages');
                    try { fs.mkdirSync(target, { recursive: true }); } catch {}
                    // Remove possibly ABI-mismatched installs from build stage
                    try {
                        const rmIfExists = (p) => { try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
                        rmIfExists(path.join(target, 'lxml'));
                        for (const name of fs.readdirSync(target)) {
                            if (/^lxml-.*\.dist-info$/i.test(name)) rmIfExists(path.join(target, name));
                        }
                    } catch (_) {}
                    const args = ['-m', 'pip', 'install', '--no-cache-dir', '--no-warn-script-location', '--upgrade', '--force-reinstall', '--prefer-binary', '--only-binary', ':all:', '--target', target, '-r', reqPath];
                    const pip = spawn(python, args, { stdio: ['ignore','pipe','pipe'], env });
                    let pipErr = '';
                    pip.stderr.on('data', d => { pipErr += d.toString(); });
                    pip.on('close', () => {
                        // Re-test regardless of pip exit code; wheels may have been present already
                        const test2 = spawn(python, testCmd, { stdio: ['ignore','pipe','pipe'], env });
                        let out2 = '';
                        test2.stdout.on('data', d => { out2 += d.toString(); });
                        test2.on('close', (code2) => {
                            if (code2 === 0 && /ok/.test(out2)) {
                                resolve(true);
                            } else {
                                // Final fallback: try older lxml compatible on wider Python versions
                                const fbArgs = ['-m','pip','install','--no-cache-dir','--no-warn-script-location','--upgrade','--prefer-binary','--only-binary',':all:','--target', target, 'python-docx>=1.2.0', 'lxml<5', 'Pillow>=8.4.0'];
                                const pipFb = spawn(python, fbArgs, { stdio: ['ignore','pipe','pipe'], env });
                                pipFb.on('close', () => {
                                    const test3 = spawn(python, testCmd, { stdio: ['ignore','pipe','pipe'], env });
                                    let out3 = '';
                                    test3.stdout.on('data', d => { out3 += d.toString(); });
                                    test3.on('close', (code3) => {
                                        if (code3 === 0 && /ok/.test(out3)) resolve(true);
                                        else resolve(false);
                                    });
                                });
                            }
                        });
                    });
                }
            });
        } catch (_) {
            resolve(false);
        }
    });
    return pythonDepsReadyPromise;
}

// Lightweight in-memory caches (TTL-based) to avoid refetching same hearing repeatedly
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000); // 2 minutes default
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 100);

const hearingAggregateCache = new Map(); // key: hearingId -> { value, expiresAt }
const hearingResponsesCache = new Map(); // key: hearingId -> { value, expiresAt }
const hearingMaterialsCache = new Map(); // key: hearingId -> { value, expiresAt }

// Optional persistent disk cache to speed up mock/demo and reduce repeated network traffic
const PERSIST_DIR = (() => {
    try {
        const envDir = String(process.env.PERSIST_DIR || '').trim();
        if (envDir && path.isAbsolute(envDir) && fs.existsSync(envDir)) return envDir;
    } catch {}
    return path.join(__dirname, 'data');
})();
try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(path.join(PERSIST_DIR, 'hearings'), { recursive: true }); } catch {}
// Prefer persisted JSON reads by default when available (helps offline mode)
const PERSIST_PREFER = String(process.env.PERSIST_PREFER || 'true').toLowerCase() !== 'false';
const OFFLINE_MODE = String(process.env.OFFLINE_MODE || '').toLowerCase() === 'true';
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
    if (!sqliteDb || !sqliteDb.prepare) {
        return { error: 'Database unavailable', status: 503 };
    }
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
        const hearingIdNum = /^\d+$/.test(String(hearingId)) ? Number(hearingId) : null;
        sqliteDb.prepare(`INSERT INTO jobs(job_id, hearing_id, state, phase, progress, created_at, updated_at, idempotency_key, input_hash) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(jobId, hearingIdNum, 'queued', 'queued', 0, now, now, idemp || null, inputHash || null);
        const insVar = sqliteDb.prepare(`INSERT INTO job_variants(job_id, variant, state, phase, progress, updated_at) VALUES (?,?,?,?,?,?)`);
        for (let i = 1; i <= n; i++) insVar.run(jobId, i, 'queued', 'queued', 0, now);
    } catch (e) {
        return { error: `DB insert failed: ${e && e.message ? e.message : String(e)}`, status: 500 };
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
    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
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
    // Build JSON array expected by wizard/UX with merged respondent fields
    const repliesObjects = (responses || []).map(r => ({
        svarnummer: (r && (r.svarnummer ?? r.id)) ?? null,
        svartekst: (r && (r.svartekst ?? r.text ?? '')) || '',
        respondentnavn: (r && (r.respondentnavn ?? r.respondentName ?? r.author ?? '')) || '',
        respondenttype: (r && (r.respondenttype ?? r.respondentType ?? 'Borger')) || 'Borger'
    }));
    const repliesText = JSON.stringify(repliesObjects, null, 2);
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
    const materialText = materialParts.join('\n');
    const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
    // Use bracketed sections to align with streaming endpoints
    const userPrompt = `${promptTemplate}\n\n[Samlede Høringssvar]\n\n${String(repliesText || '').slice(0, RESP_LIMIT)}\n\n[Høringsmateriale]\n\n${String(materialText || '').slice(0, MAT_LIMIT)}`;
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
                                const startedAt = Date.now();
                                for await (const ev of stream) {
                                    if (ev?.type === 'response.output_text.delta') acc += (ev.delta || '');
                                    if (Date.now() - startedAt > 9.5 * 60 * 1000) break;
                                }
                                if (acc && acc.length > (text||'').length) text = acc;
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

        async function sendVariantFromDb(variantId) {
            try {
                const row = sqliteDb.prepare(`SELECT markdown, summary, headings_json FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, variantId);
                if (!row) return false;
                const markdown = row?.markdown || '';
                const summary = row?.summary || '';
                const headings = row && row.headings_json ? JSON.parse(row.headings_json) : [];
                if ((markdown && markdown.trim().length) || (summary && summary.trim().length)) {
                    sendEvent('variant', { variant: { id: variantId, markdown, summary, headings } });
                    sent.add(variantId);
                    return true;
                }
                return false;
            } catch { return false; }
        }

        async function salvageAllVariants() {
            for (let i = 1; i <= n; i++) {
                if (!sent.has(i)) { try { await sendVariantFromDb(i); } catch {} }
            }
        }
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
                if (v.done && !sent.has(v.id)) { await sendVariantFromDb(v.id); }
            }
            if (snap.state === 'completed') {
                // Ensure any missing but persisted variants are emitted before end
                try { await salvageAllVariants(); } catch {}
                sendEvent('end', { message: 'Færdig' });
                break;
            }
            if (snap.state === 'failed' || snap.state === 'cancelled') {
                // Attempt to emit whatever content exists before signaling failure
                try { await salvageAllVariants(); } catch {}
                sendEvent('error', { message: snap.state === 'failed' ? 'Job fejlede' : 'Job annulleret' });
                // Also send a terminal end so clients stop spinners
                sendEvent('end', { message: 'Afslutter.' });
                break;
            }
            await new Promise(r => setTimeout(r, pollMs));
        }
    } catch (e) {
        sendEvent('error', { message: e?.message || 'Ukendt fejl' });
    } finally {
        try { if (!res.writableEnded) { try { /* final best-effort salvage */ } catch {}; res.end(); } } catch {}
    }
}

// API: Create summarize job
app.post('/api/jobs/summarize/:hearingId', express.json({ limit: '25mb' }), async (req, res) => {
    try {
        if (!sqliteDb || !sqliteDb.prepare) {
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }
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

function shouldIncludeInIndex(status) {
    // Only include hearings with status "Afventer konklusion" in the search index
    return status && status.toLowerCase().includes('afventer konklusion');
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
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'application/vnd.api+json, application/json',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                'Referer': baseUrl,
                'Origin': baseUrl,
                'Cookie': 'kk-xyz=1',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 30000,
            validateStatus: () => true
        });

        let page = 1;
        const pageSize = 50;
        const collected = [];
        for (;;) {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            const r = await withRetries(() => axiosInstance.get(url), { attempts: 3, baseDelayMs: 500 });
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
        // Only include hearings with status "Afventer konklusion"
        hearingIndex = collected
            .filter(h => shouldIncludeInIndex(h.status))
            .map(enrichHearingForIndex);
        try {
            if (sqliteDb && sqliteDb.prepare) {
                // Still save all hearings to DB, but only "Afventer konklusion" ones to index
                for (const h of collected) {
                    try { upsertHearing({ id: h.id, title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null }); } catch {}
                }
                // Update hearing index in SQLite
                if (sqliteDb.updateHearingIndex) {
                    try { sqliteDb.updateHearingIndex(hearingIndex); } catch (e) { console.warn('Failed to update hearing index:', e.message); }
                }
            }
        } catch {}

        // Fallback: If API failed or returned nothing, use sitemap + HTML (__NEXT_DATA__) to build index
        if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
            try {
                const sm = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                        'Accept': 'application/xml,text/xml,application/xhtml+xml,text/html,*/*',
                        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                        'Referer': baseUrl
                    },
                    timeout: 20000,
                    validateStatus: () => true
                });
                const candidates = [
                    `${baseUrl}/sitemap.xml`,
                    `${baseUrl}/sitemap_index.xml`,
                    `${baseUrl}/sitemap-hearing.xml`,
                    `${baseUrl}/sitemap-hearings.xml`
                ];
                const urls = new Set();
                for (const u of candidates) {
                    try {
                        const resp = await withRetries(() => sm.get(u), { attempts: 2, baseDelayMs: 400 });
                        if (resp.status !== 200 || !resp.data) continue;
                        const $ = cheerio.load(resp.data, { xmlMode: true });
                        $('loc').each((_, el) => {
                            const t = String($(el).text() || '').trim();
                            if (t) urls.add(t);
                        });
                        $('url > loc').each((_, el) => {
                            const t = String($(el).text() || '').trim();
                            if (t) urls.add(t);
                        });
                        $('sitemap > loc').each((_, el) => {
                            const t = String($(el).text() || '').trim();
                            if (t) urls.add(t);
                        });
                    } catch {}
                }
                const hearingIdFromUrl = (s) => {
                    const m = String(s || '').match(/\/hearing\/(\d+)/);
                    return m ? Number(m[1]) : null;
                };
                const ids = Array.from(urls)
                    .map(hearingIdFromUrl)
                    .filter((x) => Number.isFinite(x));
                const uniqueIds = Array.from(new Set(ids)).slice(0, 300);

                // Fetch meta via HTML for these IDs
                const axiosHtml = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Cookie': 'kk-xyz=1',
                        'Origin': baseUrl,
                        'Referer': baseUrl
                    },
                    timeout: 20000,
                    validateStatus: () => true
                });
                const out = [];
                let cursor = 0;
                const maxConcurrent = 6;
                const workers = new Array(Math.min(maxConcurrent, uniqueIds.length)).fill(0).map(async () => {
                    while (cursor < uniqueIds.length) {
                        const idx = cursor++;
                        const hid = uniqueIds[idx];
                        try {
                            const url = `${baseUrl}/hearing/${hid}`;
                            const resp = await withRetries(() => axiosHtml.get(url), { attempts: 2, baseDelayMs: 400 });
                            if (resp.status !== 200 || !resp.data) continue;
                            const $ = cheerio.load(resp.data);
                            const nextDataEl = $('script#__NEXT_DATA__');
                            if (!nextDataEl.length) continue;
                            const json = JSON.parse(nextDataEl.text());
                            // Reuse existing extractor to build meta
                            const meta = extractMetaFromNextJson(json);
                            const title = meta.title || `Høring ${hid}`;
                            out.push({ id: hid, title, startDate: meta.startDate || null, deadline: meta.deadline || null, status: meta.status || null });
                        } catch {}
                    }
                });
                await Promise.all(workers);
                if (out.length > 0) {
                    hearingIndex = out.map(enrichHearingForIndex);
                    try {
                        if (sqliteDb && sqliteDb.prepare) {
                            for (const h of hearingIndex) {
                                try { upsertHearing({ id: h.id, title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null }); } catch {}
                            }
                        }
                    } catch {}
                }
            } catch {}
        }

        // Last-resort fallback: scrape homepage for hearing links and hydrate a seed set
        if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
            try {
                const resp = await withRetries(() => axios.get(baseUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                        'Referer': baseUrl
                    },
                    timeout: 20000,
                    validateStatus: () => true
                }), { attempts: 2, baseDelayMs: 400 });
                if (resp.status === 200 && resp.data) {
                    const $ = cheerio.load(resp.data);
                    const ids = new Set();
                    $('a[href]').each((_, el) => {
                        const href = String($(el).attr('href') || '');
                        const m = href.match(/\/hearing\/(\d+)/);
                        if (m) ids.add(Number(m[1]));
                    });
                    const uniqueIds = Array.from(ids).slice(0, 100);
                    if (uniqueIds.length) {
                        const axiosHtml = axios.create({
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml',
                                'Cookie': 'kk-xyz=1',
                                'Origin': baseUrl,
                                'Referer': baseUrl
                            },
                            timeout: 20000,
                            validateStatus: () => true
                        });
                        const out = [];
                        let cursor = 0;
                        const maxConcurrent = 6;
                        const workers = new Array(Math.min(maxConcurrent, uniqueIds.length)).fill(0).map(async () => {
                            while (cursor < uniqueIds.length) {
                                const idx = cursor++;
                                const hid = uniqueIds[idx];
                                try {
                                    const url = `${baseUrl}/hearing/${hid}`;
                                    const r2 = await withRetries(() => axiosHtml.get(url), { attempts: 2, baseDelayMs: 400 });
                                    if (r2.status !== 200 || !r2.data) continue;
                                    const $p = cheerio.load(r2.data);
                                    const nextDataEl = $p('script#__NEXT_DATA__');
                                    if (!nextDataEl.length) continue;
                                    const json = JSON.parse(nextDataEl.text());
                                    const meta = extractMetaFromNextJson(json);
                                    out.push({ id: hid, title: meta.title || `Høring ${hid}`, startDate: meta.startDate || null, deadline: meta.deadline || null, status: meta.status || null });
                                } catch {}
                            }
                        });
                        await Promise.all(workers);
                        if (out.length > 0) hearingIndex = out.map(enrichHearingForIndex);
                    }
                }
            } catch {}
        }

        // Backfill missing titles by parsing the hearing page HTML (__NEXT_DATA__) with small concurrency
        let missing = hearingIndex.filter(h => !h.title || !h.title.trim());
        let retryCount = 0;
        const maxRetries = 3;
        
        while (missing.length > 0 && retryCount < maxRetries) {
            if (retryCount > 0) {
                console.log(`Retrying to fetch titles for ${missing.length} hearings (attempt ${retryCount + 1})`);
                await sleep(1000 * retryCount); // Progressive backoff
            }
            const axiosInstance2 = axios.create({
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Cookie': 'kk-xyz=1',
                    'Origin': baseUrl,
                    'Referer': baseUrl
                },
                timeout: 20000,
                validateStatus: () => true
            });

            async function fetchMetaFromHearingHtml(hearingId) {
                try {
                    const url = `${baseUrl}/hearing/${hearingId}`;
                    const resp = await withRetries(() => axiosInstance2.get(url, { validateStatus: () => true }), { attempts: 2, baseDelayMs: 400 });
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

// Public hearing index: returns current in-memory index; builds it if missing
app.get('/api/hearing-index', async (req, res) => {
    try {
        const statusLike = String(req.query.status || '').trim().toLowerCase();
        const dbOnly = String(req.query.db || '').trim() === '1';
        // DB-first: always prefer current SQLite state
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.getHearingIndex) {
                // Try to use hearing_index table first if available
                try {
                    const indexRows = sqlite.getHearingIndex();
                    if (indexRows && indexRows.length > 0) {
                        hearingIndex = indexRows;
                    }
                } catch (_) {}
            }
            // Fallback to hearings table if hearing_index is empty
            if (!hearingIndex || hearingIndex.length === 0) {
                if (sqlite && sqlite.db && sqlite.db.prepare) {
                    let rows;
                    if (statusLike) {
                        rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all(statusLike);
                                    } else {
                    rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%afventer konklusion%'`).all();
                }
                    hearingIndex = (rows || []).map(enrichHearingForIndex);
                }
            }
        } catch (_) {}

        // If explicitly DB-only, return immediately (even if empty)
        if (dbOnly) {
            const itemsDbOnly = Array.isArray(hearingIndex) ? hearingIndex : [];
            const hearingsDbOnly = itemsDbOnly.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
            return res.json({ success: true, hearings: hearingsDbOnly, count: hearingsDbOnly.length });
        }

        // Fallback: build from persisted JSON files under PERSIST_DIR if DB empty
        if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
            try {
                const baseDir = PERSIST_DIR;
                const dir1 = path.join(baseDir, 'hearings');
                const dir2 = baseDir;
                const candidates = [];
                if (fs.existsSync(dir1)) candidates.push(dir1);
                if (fs.existsSync(dir2)) candidates.push(dir2);
                const items = [];
                for (const dir of candidates) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
                    for (const f of files.slice(0, 5000)) {
                        try {
                            const raw = fs.readFileSync(path.join(dir, f), 'utf8');
                            const json = JSON.parse(raw);
                            const h = json && json.hearing;
                            if (h && Number.isFinite(Number(h.id))) {
                                const isPlaceholderTitle = !h.title || /^Høring\s+\d+$/i.test(String(h.title||''));
                                items.push({ id: Number(h.id), title: isPlaceholderTitle ? `Høring ${h.id}` : h.title, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null });
                            }
                        } catch {}
                    }
                }
                if (statusLike) {
                    hearingIndex = items.filter(x => String(x.status || '').toLowerCase().includes(statusLike)).map(enrichHearingForIndex);
                } else {
                    hearingIndex = items.map(enrichHearingForIndex);
                }
            } catch {}
        }

        // If still empty or very small, warm from remote API to build index and persist to DB
        if (!Array.isArray(hearingIndex) || hearingIndex.length < 10) {
            // Strict DB-backed warm path only
            try { await warmHearingIndex(); } catch (_) {}
            // Refresh from DB after warm
            try {
                const sqlite = require('./db/sqlite');
                if (sqlite && sqlite.db && sqlite.db.prepare) {
                    let rows;
                    if (statusLike) {
                        rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all(statusLike);
                                    } else {
                    rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%afventer konklusion%'`).all();
                }
                    hearingIndex = (rows || []).map(enrichHearingForIndex);
                }
            } catch (_) {}
        }

        let items = Array.isArray(hearingIndex) ? hearingIndex : [];
        // If index looks too small, augment from persisted JSON and persist to SQLite
        try {
            if (!Array.isArray(items) || items.length < 10) {
                const baseDir = PERSIST_DIR;
                const dir1 = path.join(baseDir, 'hearings');
                const dir2 = baseDir;
                const candidates = [];
                if (fs.existsSync(dir1)) candidates.push(dir1);
                if (fs.existsSync(dir2)) candidates.push(dir2);
                const byId = new Map(items.map(h => [Number(h.id), h]));
                for (const dir of candidates) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
                    for (const f of files.slice(0, 5000)) {
                        try {
                            const raw = fs.readFileSync(path.join(dir, f), 'utf8');
                            const json = JSON.parse(raw);
                            const h = json && json.hearing;
                            if (h && Number.isFinite(Number(h.id))) {
                                const idNum = Number(h.id);
                                if (!byId.has(idNum)) {
                                    const isPlaceholderTitle = !h.title || /^Høring\s+\d+$/i.test(String(h.title||''));
                                    const rec = enrichHearingForIndex({ id: idNum, title: isPlaceholderTitle ? `Høring ${idNum}` : h.title, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null });
                                    byId.set(idNum, rec);
                                    try { upsertHearing({ id: idNum, title: rec.title, startDate: rec.startDate, deadline: rec.deadline, status: rec.status }); } catch {}
                                }
                            }
                        } catch {}
                    }
                }
                items = Array.from(byId.values());
            }
        } catch {}

        // Backfill missing/placeholder titles and meta from HTML (__NEXT_DATA__) for up to 50 items
        try {
            const baseUrl = 'https://blivhoert.kk.dk';
            const axiosInstance = axios.create({
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/json',
                    'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                    'Cookie': 'kk-xyz=1',
                    'Origin': baseUrl,
                    'Referer': baseUrl
                },
                timeout: 20000,
                validateStatus: () => true
            });
            const needs = items.filter(h => !h || !h.title || /^Høring\s+\d+$/i.test(String(h.title||''))).slice(0, 50);
            for (const h of needs) {
                try {
                    const root = await fetchHearingRootPage(baseUrl, h.id, axiosInstance);
                    if (root && root.nextJson) {
                        const meta = extractMetaFromNextJson(root.nextJson);
                        if (meta) {
                            if (meta.title) h.title = meta.title;
                            if (meta.startDate) h.startDate = meta.startDate;
                            if (meta.deadline) h.deadline = meta.deadline;
                            if (meta.status) h.status = meta.status;
                            try { upsertHearing({ id: h.id, title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null }); } catch {}
                            // Update in-memory index as well
                            const idx = hearingIndex.findIndex(x => Number(x.id) === Number(h.id));
                            if (idx >= 0) {
                                const updated = { ...hearingIndex[idx] };
                                updated.title = h.title;
                                updated.startDate = h.startDate;
                                updated.deadline = h.deadline;
                                updated.status = h.status;
                                updated.normalizedTitle = normalizeDanish(updated.title || '');
                                updated.titleTokens = tokenize(updated.title || '');
                                updated.deadlineTs = updated.deadline ? new Date(updated.deadline).getTime() : null;
                                updated.isOpen = computeIsOpen(updated.status, updated.deadline);
                                hearingIndex[idx] = updated;
                            }
                        }
                    }
                } catch {}
            }
        } catch {}
        if (statusLike) {
            items = items.filter(h => String(h.status || '').toLowerCase().includes(statusLike));
        }
        const hearings = items.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
        return res.json({ success: true, hearings, count: hearings.length });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Kunne ikke hente hørelsesindeks', error: e.message });
    }
});

// Diagnostics: force warm-up now and report item count
app.get('/api/warm-now', async (req, res) => {
    try {
        await warmHearingIndex();
        return res.json({ success: true, count: Array.isArray(hearingIndex) ? hearingIndex.length : 0 });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Diagnostics: verify outbound connectivity to blivhoert API
app.get('/api/test-outbound', async (req, res) => {
    try {
        const baseUrl = 'https://blivhoert.kk.dk';
        const url = `${baseUrl}/api/hearing?PageIndex=1&PageSize=3`;
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                'Referer': baseUrl,
                'Cookie': 'kk-xyz=1'
            },
            timeout: 20000,
            validateStatus: () => true
        });
        const r = await axiosInstance.get(url);
        const ct = (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '';
        let sample = '';
        try { sample = JSON.stringify(r.data).slice(0, 500); } catch { sample = String(r.data).slice(0, 500); }
        return res.json({ success: true, status: r.status, contentType: ct, hasData: !!r.data, sample });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message, code: e.code || null });
    }
});

// Full hearings index with optional filtering and ordering
app.get('/api/hearings', (req, res) => {
    try {
        const { q = '' } = req.query;
        const raw = String(q || '').trim();
        const norm = normalizeDanish(raw);

        const sqlite = require('./db/sqlite');
        let results = [];
        if (sqlite && sqlite.db && sqlite.db.prepare) {
            try {
                results = sqlite.db
                    .prepare(`SELECT id, title, start_date as startDate, deadline, status FROM hearings WHERE archived IS NOT 1`)
                    .all();
            } catch (_) { results = []; }
        }

        // Fallback to in-memory index or persisted JSON if DB is empty
        if (!Array.isArray(results) || results.length === 0) {
            try {
                // If global index is empty, try to warm it from persisted JSON (support both data/ and data/hearings/)
                if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
                    try {
                        const baseDir = PERSIST_DIR;
                        const dir1 = path.join(baseDir, 'hearings');
                        const dir2 = baseDir;
                        const candidates = [];
                        if (fs.existsSync(dir1)) candidates.push(dir1);
                        if (fs.existsSync(dir2)) candidates.push(dir2);
                        const seen = new Set();
                        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
                        const items = [];
                        for (const dir of candidates) {
                            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
                            for (const f of files.slice(0, 5000)) {
                                if (seen.has(f)) continue;
                                seen.add(f);
                                try {
                                    const rawFile = fs.readFileSync(path.join(dir, f), 'utf8');
                                    const json = JSON.parse(rawFile);
                                    const h = json && json.hearing;
                                    if (h && Number.isFinite(Number(h.id))) {
                                        items.push({ id: Number(h.id), title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null });
                                    }
                                } catch {}
                            }
                        }
                        hearingIndex = items.map(enrichHearingForIndex);
                    } catch {}
                }
                results = (Array.isArray(hearingIndex) ? hearingIndex : []).map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
            } catch { results = []; }
        }

        if (norm) {
            const isNumeric = /^\d+$/.test(raw);
            results = (results || []).filter(h => {
                if (!h) return false;
                if (isNumeric && String(h.id).includes(raw)) return true;
                const normTitle = normalizeDanish(String(h.title || ''));
                return normTitle.includes(norm) || String(h.id).includes(raw);
            });
        }

        results.sort((a, b) => {
            const da = a && a.deadline ? new Date(a.deadline).getTime() : Infinity;
            const db = b && b.deadline ? new Date(b.deadline).getTime() : Infinity;
            if (da !== db) return da - db;
            return (a.id || 0) - (b.id || 0);
        });

        const out = (results || []).map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
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

        const envelopes = [];

        function scanNode(node, parent) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                if (node.some(it => it && it.type === 'comment')) {
                    const included = Array.isArray(parent?.included) ? parent.included : [];
                    const meta = parent?.meta || {};
                    envelopes.push({ data: node, included, meta });
                } else {
                    for (const item of node) scanNode(item, parent);
                }
                return;
            }
            // Object with data array containing comments
            if (Array.isArray(node.data) && node.data.some(it => it && it.type === 'comment')) {
                envelopes.push({ data: node.data, included: Array.isArray(node.included) ? node.included : [], meta: node.meta || {} });
            }
            // Object with nested data.data
            if (node.data && Array.isArray(node.data.data) && node.data.data.some(it => it && it.type === 'comment')) {
                envelopes.push({ data: node.data.data, included: Array.isArray(node.included) ? node.included : [], meta: node.meta || {} });
            }
            for (const k of Object.keys(node)) {
                scanNode(node[k], node);
            }
        }
        
        for (const query of queries) {
            const root1 = query?.state?.data;
            if (root1) scanNode(root1, null);
            const root2 = query?.state?.data?.data;
            if (root2) scanNode(root2, query?.state?.data || null);
        }

        const seenIds = new Set();
        for (const env of envelopes) {
            const pagesFromEnvelope = env?.meta?.Pagination?.totalPages;
            if (typeof pagesFromEnvelope === 'number' && pagesFromEnvelope > 0) {
                totalPages = pagesFromEnvelope;
            }
            const comments = Array.isArray(env?.data) ? env.data : [];
            const included = Array.isArray(env?.included) ? env.included : [];
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
                if (responseNumber == null) continue;
                if (seenIds.has(Number(responseNumber))) continue;
                seenIds.add(Number(responseNumber));

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
                    if (hasText) text += (text ? '\n\n' : '') + String(cattrs.textContent).trim();
                        if (hasFile) {
                            const filePath = String(cattrs.filePath || '').trim();
                            const fileName = String(cattrs.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                        attachments.push({ url: buildFileUrl(baseUrl, filePath, fileName), filename: fileName });
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
                // Try to get title directly from attributes if available
                if (hearingObj.attributes.title && !title) {
                    title = fixEncoding(String(hearingObj.attributes.title).trim());
                }
            }
            const included = Array.isArray(envelope?.included) ? envelope.included : [];
            const contents = included.filter(x => x?.type === 'content');
            
            // Look for title in content fields - try multiple field IDs
            if (!title) {
                // Field ID 1 is typically the title
                const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
            }
            
            // Fallback: look for any content field that looks like a title
            if (!title) {
                for (const content of contents) {
                    if (content?.attributes?.textContent) {
                        const text = String(content.attributes.textContent).trim();
                        // Title is typically shorter than 200 chars and doesn't contain multiple paragraphs
                        if (text.length > 0 && text.length < 200 && !text.includes('\n\n')) {
                            title = fixEncoding(text);
                            break;
                        }
                    }
                }
            }
            
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
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?page=${pageIndex}` : ''}`,
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?Page=${pageIndex}` : ''}`,
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?pageIndex=${pageIndex}` : ''}`,
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
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        // DB-first read path; fallback to persisted JSON snapshot if available
        const fromDb = readAggregate(hearingId);
        if (fromDb && fromDb.hearing) {
            // Improve meta from persisted JSON if DB has placeholders
            try {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                if (persisted && persisted.hearing) {
                    const dbH = fromDb.hearing || {};
                    const pj = persisted.hearing || {};
                    const isPlaceholderTitle = !dbH.title || /^Høring\s+\d+$/i.test(String(dbH.title||''));
                    const isUnknownStatus = !dbH.status || String(dbH.status||'').toLowerCase() === 'ukendt';
                    if (isPlaceholderTitle && pj.title) dbH.title = pj.title;
                    if (!dbH.startDate && pj.startDate) dbH.startDate = pj.startDate;
                    if (!dbH.deadline && pj.deadline) dbH.deadline = pj.deadline;
                    if (isUnknownStatus && pj.status) dbH.status = pj.status;
                    fromDb.hearing = dbH;
                }
            } catch {}
            return res.json({ success: true, hearing: fromDb.hearing, totalPages: undefined, totalResponses: (fromDb.responses||[]).length, responses: fromDb.responses });
        }
        try {
            const meta = readPersistedHearingWithMeta(hearingId);
            const persisted = meta?.data;
            if (persisted && persisted.success && persisted.hearing) {
                // Best-effort: also persist to SQLite so subsequent DB reads work offline
                try { upsertHearing(persisted.hearing); } catch {}
                try { if (Array.isArray(persisted.responses)) replaceResponses(Number(hearingId), persisted.responses); } catch {}
                return res.json({
                    success: true,
                    hearing: persisted.hearing,
                    totalPages: persisted.totalPages || undefined,
                    totalResponses: Array.isArray(persisted.responses) ? persisted.responses.length : 0,
                    responses: Array.isArray(persisted.responses) ? persisted.responses : []
                });
            }
        } catch {}
        return res.status(404).json({ success: false, message: 'Ikke fundet i databasen' });

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
            // Ignore API errors
        }
        // If HTML suggested multiple pages but we still have exactly 12 responses, try a last HTML loop pass
        if (normalizedResponses.length === 12 && (typeof totalPages === 'number' ? totalPages > 1 : true)) {
            try {
                let pageIndex = 2;
                let guard = 0;
                while (guard < 10) {
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 300 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (!pageItems.length) break;
                    htmlResponses = htmlResponses.concat(pageItems);
                    pageIndex += 1;
                    guard += 1;
                }
            } catch {}
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

        // Unreachable in DB-only mode
    } catch (error) {
        console.error(`Error in /api/hearing/${req.params.id}:`, error.message);
        res.status(500).json({ success: false, message: 'Uventet fejl', error: error.message });
    }
});

// Split endpoints: meta and responses separately
app.get('/api/hearing/:id/meta', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'kk-xyz=1' }, timeout: 30000 });

        let hearingMeta = { title: null, deadline: null, startDate: null, status: null };
        // Offline-first: if we have meta in DB, use it and return immediately
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.db && sqlite.db.prepare) {
                const row = sqlite.db.prepare(`SELECT title, start_date as startDate, deadline, status FROM hearings WHERE id=?`).get(Number(hearingId));
                if (row && row.title) {
                    return res.json({ success: true, hearing: { id: Number(hearingId), title: row.title, startDate: row.startDate || null, deadline: row.deadline || null, status: row.status || 'ukendt', url: `${baseUrl}/hearing/${hearingId}/comments` } });
                }
            }
        } catch {}
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
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        const noCache = String(req.query.nocache || '').trim() === '1';
        const preferPersist = PERSIST_PREFER || String(req.query.persist || '').trim() === '1';
        // Offline-first: read from DB if available
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.db && sqlite.db.prepare) {
                const rows = sqlite.db.prepare(`SELECT response_id as id, text, author, organization, on_behalf_of as onBehalfOf, submitted_at as submittedAt FROM responses WHERE hearing_id=? ORDER BY response_id ASC`).all(hearingId);
                const atts = sqlite.db.prepare(`SELECT response_id as id, idx, filename, url FROM attachments WHERE hearing_id=? ORDER BY response_id ASC, idx ASC`).all(hearingId);
                const byId = new Map(rows.map(r => [Number(r.id), { ...r, attachments: [] }]));
                for (const a of atts) {
                    const t = byId.get(Number(a.id)); if (t) t.attachments.push({ filename: a.filename, url: a.url });
                }
                const arr = Array.from(byId.values());
                if (arr.length) return res.json({ success: true, totalResponses: arr.length, responses: arr });
            }
        } catch {}
        // Persisted JSON fallback
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
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/json',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': 'kk-xyz=1',
                'Referer': `${baseUrl}/hearing/${hearingId}/comments`,
                'Origin': baseUrl
            },
            timeout: 30000
        });
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
        let normalized = normalizeResponses(merged);

        // Defensive: if we only got exactly 12, try a small extra loop over more pages
        if (normalized.length === 12) {
            try {
                let pageIndex = 2;
                let guard = 0;
                while (guard < 10) {
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 300 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (!pageItems.length) break;
                    htmlResponses = htmlResponses.concat(pageItems);
                    pageIndex += 1;
                    guard += 1;
                }
                normalized = normalizeResponses(mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []));
            } catch {}
        }
        const payload = { success: true, totalResponses: normalized.length, responses: normalized };
        // Persist to SQLite for DB-first flows
        try { upsertHearing({ id: Number(hearingId), title: `Høring ${hearingId}`, startDate: null, deadline: null, status: 'ukendt' }); } catch (_) {}
        try { replaceResponses(Number(hearingId), normalized); } catch (_) {}
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
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        // Prefer DB, but gracefully fall back to persisted JSON if DB is unavailable/empty
        try {
            const rows = (sqliteDb && sqliteDb.prepare)
                ? sqliteDb.prepare(`SELECT * FROM materials WHERE hearing_id=? ORDER BY idx ASC`).all(hearingId)
                : [];
            let materials = (rows || []).map(m => ({ type: m.type, title: m.title, url: m.url, content: m.content }));
            if (!materials || materials.length === 0) {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                if (persisted && Array.isArray(persisted.materials) && persisted.materials.length > 0) {
                    materials = persisted.materials.map(m => ({ type: m.type, title: m.title || null, url: m.url || null, content: m.content || null }));
                }
            }
            // If still empty, try to extract directly from the hearing root HTML (__NEXT_DATA__) and simple anchor scan
            if (!materials || materials.length === 0) {
                const baseUrl = 'https://blivhoert.kk.dk';
                const axiosInstance = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/json',
                        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                        'Cookie': 'kk-xyz=1',
                        'Origin': baseUrl,
                        'Referer': baseUrl
                    },
                    timeout: 20000
                });
                try {
                    const root = await fetchHearingRootPage(baseUrl, hearingId, axiosInstance);
                    if (Array.isArray(root.materials) && root.materials.length > 0) {
                        materials = root.materials;
                    } else {
                        // Simple anchor fallback
                        const url = `${baseUrl}/hearing/${hearingId}`;
                        const r = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 2, baseDelayMs: 300 });
                        if (r.status === 200 && r.data) {
                            const $ = cheerio.load(r.data);
                            const list = [];
                            $('a[href]').each((_, el) => {
                                const href = String($(el).attr('href') || '').trim();
                                if (/\.(pdf|doc|docx|xls|xlsx)(\?|$)/i.test(href)) {
                                    const title = ($(el).text() || '').trim();
                                    const abs = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/')?'':'/'}${href}`;
                                    list.push({ type: 'file', title: title || 'Dokument', url: abs });
                                }
                            });
                            if (list.length) materials = list;
                        }
                    }
                } catch {}
                // Persist if configured
                if (PERSIST_ALWAYS_WRITE) {
                    const meta = readPersistedHearingWithMeta(hearingId);
                    const existing = meta?.data || { success: true, hearing: { id: Number(hearingId) }, responses: [] };
                    const merged = { ...existing, materials: materials || [] };
                    writePersistedHearing(hearingId, merged);
                }
            }
            return res.json({ success: true, materials: materials || [] });
        } catch {
            try {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                const materials = (persisted && Array.isArray(persisted.materials)) ? persisted.materials : [];
            return res.json({ success: true, materials });
        } catch {
            return res.json({ success: true, materials: [] });
            }
        }
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
// Warm endpoint disabled in DB-only/static mode (kept for compatibility)
app.post('/api/warm/:id', async (req, res) => {
    return res.json({ success: true, queued: false, skipped: true, reason: 'disabled' });
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
        const dbReady = !!(sqliteDb && sqliteDb.prepare);
        if (BACKGROUND_MODE && !forceDirect && dbReady) {
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
        if (!/^\d+$/.test(hearingId)) {
            sendEvent('error', { message: 'Ugyldigt hørings-ID' });
            return res.end();
        }
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
        // Ensure materials and responses are populated even if main aggregate lacked them
        let materials = Array.isArray(metaResp.data?.materials) ? metaResp.data.materials : [];
        if (!materials.length) {
            try {
                const mats = await axios.get(`${base}/api/hearing/${hearingId}/materials?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                if (mats && mats.data && mats.data.success && Array.isArray(mats.data.materials)) materials = mats.data.materials;
            } catch {}
            if (!materials.length) {
                try {
                    const mats2 = await axios.get(`${base}/api/hearing/${hearingId}/materials?db=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                    if (mats2 && mats2.data && mats2.data.success && Array.isArray(mats2.data.materials)) materials = mats2.data.materials;
                } catch {}
            }
            if (!materials.length) {
                try {
                    const mats3 = await axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                    if (mats3 && mats3.data && mats3.data.success && Array.isArray(mats3.data.materials)) materials = mats3.data.materials;
                } catch {}
            }
        }

        sendEvent('info', { message: 'Forbereder dokumenter...' });
        sendEvent('status', { phase: 'preparing', message: 'Forbereder materiale til prompt…' });
        
        const tmpDir = ensureTmpDir();
        const repliesMdPath = path.join(tmpDir, `hearing_${hearingId}_responses.md`);
        const materialMdPath = path.join(tmpDir, `hearing_${hearingId}_material.md`);

        // Stream immediate user-facing status while building prompt
        sendEvent('info', { message: 'Bygger materiale til prompt…' });
        // Build JSON with svarnummer, svartekst, respondentnavn, respondenttype (merged with wizard edits)
        const repliesObjects = responses.map(r => ({
            svarnummer: (r && (r.svarnummer ?? r.id)) ?? null,
            svartekst: (r && (r.svartekst ?? r.text ?? '')) || '',
            respondentnavn: (r && (r.respondentnavn ?? r.respondentName ?? r.author ?? '')) || '',
            respondenttype: (r && (r.respondenttype ?? r.respondentType ?? 'Borger')) || 'Borger'
        }));
        const repliesText = JSON.stringify(repliesObjects, null, 2);
        fs.writeFileSync(repliesMdPath, repliesText, 'utf8');

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
        const userPrompt = `${promptTemplate}\n\n[Samlede Høringssvar]\n\n${String(repliesText || '').slice(0, RESP_LIMIT)}\n\n[Høringsmateriale] \n\n${materialMd.slice(0, MAT_LIMIT)}`;
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
        const preThoughts = computePreThoughts(`${repliesText}\n${materialMd}`);

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
                            recordRecentVariant(hearingId, variant);
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
                recordRecentVariant(hearingId, variant);
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
        
        req.on('close', async () => {
            try { clearInterval(keepAliveInterval); } catch (_) {}
            // If direct streaming was planned (bg=0), salvage by creating a background job so results persist
            try {
                const bgParamClose = String(req.query.bg || '').trim().toLowerCase();
                const forceDirectClose = bgParamClose === '0' || bgParamClose === 'false' || bgParamClose === 'no';
                const dbReadyClose = !!(sqliteDb && sqliteDb.prepare);
                if (forceDirectClose && dbReadyClose) {
                    try {
                        const hearingIdClose = String(req.params.id).trim();
                        const nClose = Number(req.query.n || parsedBody?.n || DEFAULT_VARIANTS);
                        const payloadClose = {
                            hearing: parsedBody?.hearing || null,
                            responses: parsedBody?.responses || null,
                            materials: parsedBody?.materials || null,
                            edits: parsedBody?.edits || null,
                            n: nClose
                        };
                        const created = await createJob(req, hearingIdClose, payloadClose);
                        if (!created?.error && created?.jobId) {
                            logDebug(`[summarize] Client disconnected; started background job ${created.jobId}`);
                        }
                    } catch (e) {
                        logDebug(`[summarize] Disconnect salvage failed: ${e?.message || e}`);
                    }
                }
            } catch (_) {}
            // Do not resolve here; allow summarization worker to complete and record recent variants in memory
            try { if (!res.writableEnded) logDebug('[summarize] Client disconnected; continuing generation off-connection'); } catch {}
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
                const dbReady2 = !!(sqliteDb && sqliteDb.prepare);
                if (BACKGROUND_MODE && !forceDirect2 && dbReady2) {
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
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
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
                    // Ensure materials present by probing alternative endpoints when empty
                    if (!materials || materials.length === 0) {
                        try {
                            const mats = await axios.get(`${base}/api/hearing/${hearingId}/materials?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                            if (mats && mats.data && mats.data.success && Array.isArray(mats.data.materials)) materials = mats.data.materials;
                        } catch {}
                        if (!materials || materials.length === 0) {
                            try {
                                const mats2 = await axios.get(`${base}/api/hearing/${hearingId}/materials?db=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                                if (mats2 && mats2.data && mats2.data.success && Array.isArray(mats2.data.materials)) materials = mats2.data.materials;
                            } catch {}
                        }
                        if (!materials || materials.length === 0) {
                            try {
                                const mats3 = await axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                                if (mats3 && mats3.data && mats3.data.success && Array.isArray(mats3.data.materials)) materials = mats3.data.materials;
                            } catch {}
                        }
                    }
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
                        }
                    } catch (_) {}
                    
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
                                                        // Retrieve the final output immediately and emit variant, then resolve
                                                        try {
                                                            const job = await openai.responses.retrieve(responseId);
                                                            let text = '';
                                                            if (job) {
                                                                if (typeof job.output_text === 'string') text = job.output_text;
                                                                else if (Array.isArray(job.output_text)) text = job.output_text.join('\n');
                                                                else if (Array.isArray(job.output)) {
                                                                    try { text = job.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n'); } catch (_) {}
                                                                }
                                                            }
                                                            const markdown = (text || '').trim();
                                                            if (markdown) {
                                                                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                                                const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                                                sendEvent('variant', { variant });
                                                                const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                                                if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });
                                                            }
                                                        } catch (_) {}
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

                                        logDebug(`[summarize] Variant ${variantId}: Polling complete. Emitting final result without streaming.`);
                                        // Do NOT stream by response_id (can TTL). We already emitted variant above if content was present.
                                        // If no markdown was emitted during completion branch, perform a last retrieve to populate it.
                                        try {
                                            if (!markdown || !markdown.trim()) {
                                                const job = await openai.responses.retrieve(responseId);
                                                const text = parseOpenAIText(job);
                                                markdown = (text || '').trim();
                                            }
                                        } catch {}
                                        if (markdown && markdown.trim().length) {
                                            const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                            const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                            sendEvent('variant', { variant });
                                            const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                            if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });
                                        }
                                        // Mark done and stop this variant task
                                        sendEvent('status', { id: variantId, phase: 'done', message: 'Færdig' });
                                        return;

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
        // Ensure python deps
        try { await ensurePythonDeps(); } catch {}
        const tmpDir = ensureTmpDir();
        const outPath = path.join(tmpDir, `${outFileName || 'output'}.docx`);

        const python = process.env.PYTHON_BIN || 'python3';
        // Always use the canonical builder script
        const scriptPath = path.join(__dirname, 'scripts', 'build_docx.py');
        // Prefer scriptskabelon paths for template and block if present; fallback to templates/
        const blockCandidates = [
            path.join(__dirname, 'scriptskabelon', 'blok.md'),
            path.join(__dirname, 'templates', 'blok.md')
        ];
        const templateCandidates = [
            TEMPLATE_DOCX,
            path.join(__dirname, 'scriptskabelon', 'Bilag 6 Svar på henvendelser i høringsperioden.docx'),
            path.join(__dirname, 'templates', 'Bilag 6 Svar på henvendelser i høringsperioden.docx')
        ];
        const templateBlockPath = blockCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || blockCandidates[blockCandidates.length - 1];
        const templateDocxPath = templateCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || TEMPLATE_DOCX;

        const args = [
            scriptPath,
            '--markdown', '-',
            '--out', outPath,
            '--template', templateDocxPath,
            '--template-block', templateBlockPath
        ];
        const localPy = path.join(__dirname, 'python_packages');
        const mergedPyPath = [localPy, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const env = { ...process.env, PYTHONPATH: mergedPyPath };
        const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        let stdout = '';
        let stderr = '';
        child.stdin.write(markdown);
        child.stdin.end();
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', async (code) => {
            if (code !== 0) {
                console.error('DOCX build error:', stderr);
                // Fallback: build a simple DOCX via Node if Python failed
                try {
                    const ok = await buildDocxFallbackNode(markdown, outPath);
                    if (ok) {
                        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
                        return fs.createReadStream(outPath).pipe(res);
                    }
                } catch (_) {}
                return res.status(500).json({ success: false, message: 'DOCX bygning fejlede', error: stderr || `exit ${code}` });
            }
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
            fs.createReadStream(outPath).pipe(res);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved DOCX bygning', error: e.message });
    }
});


// Test endpoint: build DOCX from bundled scriptskabelon/testOutputLLM.md
app.get('/api/test-docx', async (req, res) => {
    try {
        // Prefer scriptskabelon test if present; fallback to templates
        const sampleCandidates = [
            path.join(__dirname, 'scriptskabelon', 'testOutputLLM.md'),
            path.join(__dirname, 'templates', 'testOutputLLM.md')
        ];
        const samplePath = sampleCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || sampleCandidates[sampleCandidates.length - 1];
        if (!fs.existsSync(samplePath)) {
            return res.status(404).json({ success: false, message: 'Prøvedata ikke fundet' });
        }
        const markdown = fs.readFileSync(samplePath, 'utf8');
        // Ensure python deps
        try { await ensurePythonDeps(); } catch {}
        const tmpDir = ensureTmpDir();
        const outPath = path.join(tmpDir, `test_${Date.now()}.docx`);

        const python = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, 'scripts', 'build_docx.py');
        const blockCandidates = [
            path.join(__dirname, 'scriptskabelon', 'blok.md'),
            path.join(__dirname, 'templates', 'blok.md')
        ];
        const templateCandidates = [
            TEMPLATE_DOCX,
            path.join(__dirname, 'scriptskabelon', 'Bilag 6 Svar på henvendelser i høringsperioden.docx'),
            path.join(__dirname, 'templates', 'Bilag 6 Svar på henvendelser i høringsperioden.docx')
        ];
        const templateBlockPath = blockCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || blockCandidates[blockCandidates.length - 1];
        const templateDocxPath = templateCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || TEMPLATE_DOCX;
        const args = [
            scriptPath,
            '--markdown', '-',
            '--out', outPath,
            '--template', templateDocxPath,
            '--template-block', templateBlockPath
        ];
        const localPy2 = path.join(__dirname, 'python_packages');
        const mergedPyPath2 = [localPy2, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const env = { ...process.env, PYTHONPATH: mergedPyPath2 };
        const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        let stderr = '';
        child.stdin.write(markdown);
        child.stdin.end();
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', async (code) => {
            if (code !== 0) {
                // Fallback: build a simple DOCX via Node if Python failed
                try {
                    const ok = await buildDocxFallbackNode(markdown, outPath);
                    if (ok) {
                        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                        res.setHeader('Content-Disposition', 'attachment; filename="test_output.docx"');
                        return fs.createReadStream(outPath).pipe(res);
                    }
                } catch (_) {}
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

// Latest variants for a hearing (from the most recent job), for robust client fallback
app.get('/api/hearing/:id/variants/latest', (req, res) => {
    try {
        if (!sqliteDb || !sqliteDb.prepare) {
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }
        const hid = String(req.params.id).trim();
        const row = sqliteDb.prepare(`SELECT job_id FROM jobs WHERE hearing_id = ? ORDER BY updated_at DESC LIMIT 1`).get(Number(hid));
        if (!row || !row.job_id) {
            return res.json({ success: true, variants: [] });
        }
        const rows = sqliteDb.prepare(`SELECT variant as id, markdown, summary, headings_json as headingsJson FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(row.job_id);
        const variants = rows.map(r => ({ id: r.id, markdown: r.markdown || '', summary: r.summary || '', headings: r.headingsJson ? JSON.parse(r.headingsJson) : [] }))
            .filter(v => (v.markdown && v.markdown.trim().length) || (v.summary && v.summary.trim().length));
        return res.json({ success: true, variants });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// Recent in-memory variants (best-effort) for very fresh results even if DB not yet updated
app.get('/api/hearing/:id/variants/recent', (req, res) => {
    try {
        const hid = String(req.params.id || '').trim();
        if (!hid || !recentVariantsByHearing.has(hid)) return res.json({ success: true, variants: [] });
        const m = recentVariantsByHearing.get(hid);
        const out = Array.from(m.values()).sort((a,b) => Number(a.id) - Number(b.id));
        return res.json({ success: true, variants: out });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
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

// Test SQLite installation
app.get('/api/test-sqlite', (req, res) => {
    try {
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (e) {
            return res.json({ 
                betterSqlite3: false, 
                error: e.message,
                stack: e.stack 
            });
        }
        
        const testPath = path.join(process.cwd(), 'test.db');
        try {
            const testDb = new Database(testPath);
            testDb.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER)');
            const result = testDb.prepare('SELECT 1 as test').get();
            testDb.close();
            fs.unlinkSync(testPath);
            
            return res.json({ 
                betterSqlite3: true, 
                testSuccess: true,
                result,
                testPath
            });
        } catch (e) {
            return res.json({ 
                betterSqlite3: true, 
                testSuccess: false,
                error: e.message,
                stack: e.stack,
                testPath
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Force database re-initialization endpoint
app.post('/api/db-reinit', (req, res) => {
    try {
        console.log('[API] Forcing database re-initialization...');
        initDb();
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.db && sqlite.db.prepare) sqlite.db.prepare('SELECT 1').get();
        } catch {}
        res.json({ success: true, message: 'Database re-initialized' });
    } catch (e) {
        console.error('[API] Database re-init failed:', e);
        res.status(500).json({ success: false, error: e.message, stack: e.stack });
    }
});

// Database status endpoint for debugging
app.get('/api/db-status', (req, res) => {
    try {
        const isRender = process.env.RENDER === 'true';
        const dbPath = process.env.DB_PATH || (isRender 
            ? '/opt/render/project/src/fetcher/data/app.sqlite'
            : path.join(__dirname, 'data', 'app.sqlite'));
        const status = {
            dbPath: dbPath,
            isRender: isRender,
            dbExists: false,
            hearingCount: 0,
            responseCount: 0,
            materialCount: 0,
            lastHearingUpdate: null,
            error: null,
            fileExists: fs.existsSync(dbPath),
            dirExists: fs.existsSync(path.dirname(dbPath)),
            workingDir: process.cwd()
        };
        
        if (sqliteDb && sqliteDb.prepare) {
            try {
                status.dbExists = true;
                status.hearingCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM hearings').get().count;
                status.responseCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM responses').get().count;
                status.materialCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM materials').get().count;
                
                const lastUpdate = sqliteDb.prepare('SELECT MAX(updated_at) as last FROM hearings').get();
                status.lastHearingUpdate = lastUpdate.last ? new Date(lastUpdate.last).toISOString() : null;
            } catch (e) {
                status.error = e.message;
                status.errorStack = e.stack;
            }
        } else {
            status.error = 'Database not initialized';
            status.sqliteDb = !!sqliteDb;
            status.sqliteDbPrepare = !!(sqliteDb && sqliteDb.prepare);
        }
        
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Rebuild/warm hearings search index on demand (fire-and-forget)
app.post('/api/rebuild-index', async (req, res) => {
    try {
        setImmediate(() => {
            try { warmHearingIndex().catch(() => {}); } catch {}
        });
        res.json({ success: true, queued: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke starte genopbygning' });
    }
});

// Prefetch and persist all data for a hearing (meta+responses+materials) to disk
app.post('/api/prefetch/:id', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        const apiOnly = String(req.query.apiOnly || '').trim() === '1' || API_ONLY_PREFETCH;
        if (prefetchInFlight.has(hearingId)) {
            return res.json({ success: true, skipped: true, reason: 'in-flight' });
        }
        prefetchInFlight.add(hearingId);
        let payload = null;
        if (apiOnly) {
            // Use API-only routes to avoid HTML scraping for cron/prefetch.
            // IMPORTANT: The DB-only aggregate endpoint may 404 if not yet persisted.
            // Prefer the dedicated meta endpoint which fetches from source.
            const [metaResp, resps, mats] = await Promise.all([
                axios.get(`${base}/api/hearing/${hearingId}/meta`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/responses?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS })
            ]);
            if (metaResp.status === 200 && metaResp.data && metaResp.data.success) {
                payload = {
                    success: true,
                    hearing: metaResp.data.hearing,
                    responses: Array.isArray(resps?.data?.responses) ? resps.data.responses : [],
                    materials: Array.isArray(mats?.data?.materials) ? mats.data.materials : [],
                    totalPages: metaResp.data.totalPages || undefined
                };
            } else {
                // Fallback minimal payload allows persisting responses/materials even if meta fails
                payload = {
                    success: true,
                    hearing: { id: Number(hearingId), title: `Høring ${hearingId}`, startDate: null, deadline: null, status: 'ukendt' },
                    responses: Array.isArray(resps?.data?.responses) ? resps.data.responses : [],
                    materials: Array.isArray(mats?.data?.materials) ? mats.data.materials : []
                };
            }
        } else {
            const [agg, resps, mats] = await Promise.all([
                axios.get(`${base}/api/hearing/${hearingId}?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/responses?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS })
            ]);
            if (agg.status === 200 && agg.data && agg.data.success) payload = agg.data;
            else if (resps.status === 200 && mats.status === 200 && resps.data && mats.data) {
                payload = {
                    success: true,
                    hearing: { id: Number(hearingId) },
                    responses: Array.isArray(resps.data.responses) ? resps.data.responses : [],
                    materials: Array.isArray(mats.data.materials) ? mats.data.materials : []
                };
            }
        }
        if (!payload) { prefetchInFlight.delete(hearingId); return res.status(500).json({ success: false, message: 'Kunne ikke hente data' }); }

        // Fallback: If materials are missing, try a targeted hydration to extract materials
        try {
            const needsMaterials = !Array.isArray(payload.materials) || payload.materials.length === 0;
            if (needsMaterials) {
                const hyd = await hydrateHearingDirect(hearingId);
                if (hyd && hyd.success) {
                    // Prefer responses with more items
                    if (Array.isArray(hyd.materials) && hyd.materials.length > 0) {
                        payload.materials = hyd.materials;
                    }
                    if (Array.isArray(hyd.responses) && ((payload.responses||[]).length < hyd.responses.length)) {
                        payload.responses = hyd.responses;
                    }
                    if (payload.hearing && typeof payload.hearing === 'object') {
                        // If hydrate wrote improved meta to DB, keep current payload.hearing as-is
                    }
                }
            }
        } catch {}
        writePersistedHearing(hearingId, payload);
        // Also persist to SQLite for stable reads (use fresh handle to avoid stale captures)
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && typeof sqlite.upsertHearing === 'function' && sqlite.db && sqlite.db.prepare) {
                if (payload.hearing) sqlite.upsertHearing(payload.hearing);
                if (Array.isArray(payload.responses)) sqlite.replaceResponses(hearingId, payload.responses);
                if (Array.isArray(payload.materials)) sqlite.replaceMaterials(hearingId, payload.materials);
            } else {
            if (payload.hearing) upsertHearing(payload.hearing);
            if (Array.isArray(payload.responses)) replaceResponses(hearingId, payload.responses);
            if (Array.isArray(payload.materials)) replaceMaterials(hearingId, payload.materials);
            }
        } catch (e) {
            console.error('[prefetch] SQLite persist failed:', e && e.message ? e.message : e);
        }
        prefetchInFlight.delete(hearingId);
        res.json({ success: true, message: 'Prefetch gemt', counts: { responses: payload.responses?.length || 0, materials: payload.materials?.length || 0 } });
    } catch (e) {
        try { prefetchInFlight.delete(String(req.params.id).trim()); } catch {}
        res.status(500).json({ success: false, message: 'Prefetch-fejl', error: e.message });
    }
});

// Kick off a one-off job on Render to run our prefetch endpoint.
// Body: { hearingId: number, apiOnly?: boolean }
app.post('/api/render-job/prefetch', express.json({ limit: '256kb' }), async (req, res) => {
    try {
        const hearingId = Number(req.body?.hearingId);
        const apiOnly = !!req.body?.apiOnly;
        if (!Number.isFinite(hearingId)) return res.status(400).json({ success: false, message: 'Ugyldigt hearingId' });
        if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(400).json({ success: false, message: 'Render API mangler konfiguration' });

        // Build a job that curls our own endpoint within the same service container
        // Render will boot a new instance of this service with the provided command
        const command = `bash -lc "curl -s -X POST ${process.env.PUBLIC_URL || 'http://localhost:'+PORT}/api/prefetch/${hearingId}?apiOnly=${apiOnly?'1':'0'} -H 'Content-Type: application/json' --data '{"reason":"render-job"}' | cat"`;
        const url = `${RENDER_API_BASE}/v1/services/${encodeURIComponent(RENDER_SERVICE_ID)}/jobs`;
        const r = await axios.post(url, { command }, { headers: { Authorization: `Bearer ${RENDER_API_KEY}` }, validateStatus: () => true });
        if (r.status >= 200 && r.status < 300) {
            return res.json({ success: true, job: r.data });
        }
        return res.status(r.status || 500).json({ success: false, message: 'Render job fejlede', error: r.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke oprette Render job', error: e.message });
    }
});

// Create a Render one-off job that hits our refresh-open endpoint to prefetch all target hearings
app.post('/api/render-job/refresh-open', async (req, res) => {
    try {
        if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(400).json({ success: false, message: 'Render API mangler konfiguration' });
        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        const command = `bash -lc "curl -sS -X POST '${base}/api/refresh/open' | cat"`;
        const url = `${RENDER_API_BASE}/v1/services/${encodeURIComponent(RENDER_SERVICE_ID)}/jobs`;
        const r = await axios.post(url, { command }, { headers: { Authorization: `Bearer ${RENDER_API_KEY}` }, validateStatus: () => true });
        if (r.status >= 200 && r.status < 300) {
            return res.json({ success: true, job: r.data });
        }
        return res.status(r.status || 500).json({ success: false, message: 'Render job fejlede', error: r.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke oprette Render job', error: e.message });
    }
});

// Create HTTP server explicitly to control keepAlive and header timeouts (helps SSE on some proxies)
const server = http.createServer(app);
try { server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS; } catch {}
try { server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS; } catch {}
try { if (typeof server.requestTimeout !== 'undefined') server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS; } catch {}

// Validate/sanitize cron specs to avoid runtime errors inside node-cron
function resolveCronSpec(value, fallback) {
    try {
        const raw = (typeof value === 'string') ? value.trim() : '';
        const spec = raw || fallback;
        if (typeof spec !== 'string' || !spec.trim()) return fallback;
        if (typeof cron.validate === 'function') {
            return cron.validate(spec) ? spec : fallback;
        }
        // If validate not available, do a simple shape check: at least 5 fields
        const parts = spec.trim().split(/\s+/);
        if (parts.length >= 5 && parts.length <= 7) return spec;
        return fallback;
    } catch {
        return fallback;
    }
}

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Warm search index after server is listening
    loadIndexFromDisk();
    // Build search index from SQLite only at runtime
    try {
        if (sqliteDb && sqliteDb.prepare) {
            const rows = sqliteDb.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all('afventer konklusion');
            hearingIndex = (rows || []).map(enrichHearingForIndex);
        }
    } catch (e) {
        console.warn('Index from DB failed at startup:', e && e.message);
    }
    // On deploy: run a full scrape/hydration once (non-blocking)
    (async () => {
        try {
            console.log('[Server] Running startup data scrape...');
            const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
            const response = await axios.post(`${base}/api/run-daily-scrape`, { reason: 'startup' }, { validateStatus: () => true, timeout: 120000 });
            console.log('[Server] Startup scrape response:', response.status, response.data);
        } catch (e) {
            console.error('[Server] Startup scrape failed:', e.message);
        }
    })();
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
            // Daily discovery+hydrate focused on 'Afventer konklusion'
            const dailySpec = resolveCronSpec(process.env.CRON_DAILY_SCRAPE || '0 3 * * *', '0 3 * * *');
            cron.schedule(dailySpec, async () => {
                try {
                    // Discover
                    const baseApi = 'https://blivhoert.kk.dk/api/hearing';
                    let page = 1;
                    const pageSize = 50;
                    const ids = [];
                    for (;;) {
                        const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
                        const r = await axios.get(url, { validateStatus: () => true });
                        if (r.status !== 200 || !r.data) break;
                        const items = Array.isArray(r.data?.data) ? r.data.data : [];
                        const included = Array.isArray(r.data?.included) ? r.data.included : [];
                        const statusById = new Map();
                        for (const inc of included) if (inc?.type === 'hearingStatus') statusById.set(String(inc.id), inc?.attributes?.name || null);
                        for (const it of items) {
                            if (!it || it.type !== 'hearing') continue;
                            const statusRelId = it.relationships?.hearingStatus?.data?.id;
                            const statusText = statusById.get(String(statusRelId)) || null;
                            if (String(statusText || '').toLowerCase().includes('afventer konklusion')) {
                                ids.push(Number(it.id));
                            }
                        }
                        const totalPages = r.data?.meta?.Pagination?.totalPages || page;
                        if (page >= totalPages) break;
                        page += 1;
                    }
                    const targetIds = Array.from(new Set(ids)).filter(Number.isFinite);
                    // Archive any hearings in DB not in target set
                    try {
                        const existing = listAllHearingIds();
                        const targetSet = new Set(targetIds);
                        for (const id of existing) {
                            if (!targetSet.has(id)) setHearingArchived(id, 1);
                            else setHearingArchived(id, 0);
                        }
                    } catch {}
                    // Hydrate each target id using prefetch (network), then mark complete
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                    let idx = 0;
                    const workers = new Array(Math.min(REFRESH_CONCURRENCY, Math.max(1, targetIds.length))).fill(0).map(async () => {
                        while (idx < targetIds.length) {
                            const id = targetIds[idx++];
                            try {
                                // Skip if already complete (static dataset)
                                try { const comp = isHearingComplete(id); if (comp && comp.complete) continue; } catch {}
                                await hydrateHearingDirect(id);
                            } catch {}
                        }
                    });
                    await Promise.all(workers);
                    // Rebuild in-memory index from DB
                    try {
                        const rows = sqliteDb.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all('afventer konklusion');
                        hearingIndex = (rows || []).map(enrichHearingForIndex);
                    } catch {}
                } catch (e) {
                    console.warn('Daily scrape failed:', e && e.message);
                }
            });

            // Expose an admin endpoint to trigger daily scrape on demand
            app.post('/api/run-daily-scrape', async (req, res) => {
                try {
                    await (async () => { try { await axios.post(`http://localhost:${PORT}/__internal/run-daily-scrape`); } catch {} })();
                    res.json({ success: true, queued: true });
                } catch (e) {
                    res.status(500).json({ success: false, message: 'Kunne ikke starte daglig scraping' });
                }
            });
            // Internal endpoint called above to avoid re-creating logic in route handler
            app.post('/__internal/run-daily-scrape', async (req, res) => {
                try {
                    const run = async () => {
                        try {
                            const baseApi = 'https://blivhoert.kk.dk/api/hearing';
                            let page = 1; const pageSize = 50; const ids = [];
                            for (;;) {
                                const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
                                const r = await axios.get(url, { validateStatus: () => true });
                                if (r.status !== 200 || !r.data) break;
                                const items = Array.isArray(r.data?.data) ? r.data.data : [];
                                const included = Array.isArray(r.data?.included) ? r.data.included : [];
                                const statusById = new Map();
                                for (const inc of included) if (inc?.type === 'hearingStatus') statusById.set(String(inc.id), inc?.attributes?.name || null);
                                for (const it of items) {
                                    if (!it || it.type !== 'hearing') continue;
                                    const statusRelId = it.relationships?.hearingStatus?.data?.id;
                                    const statusText = statusById.get(String(statusRelId)) || null;
                                    if (String(statusText || '').toLowerCase().includes('afventer konklusion')) ids.push(Number(it.id));
                                }
                                const totalPages = r.data?.meta?.Pagination?.totalPages || page;
                                if (page >= totalPages) break;
                                page += 1;
                            }
                            const targetIds = Array.from(new Set(ids)).filter(Number.isFinite);
                            const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                            let idx = 0;
                            const workers = new Array(Math.min(REFRESH_CONCURRENCY, Math.max(1, targetIds.length))).fill(0).map(async () => {
                                while (idx < targetIds.length) {
                                    const id = targetIds[idx++];
                                    try {
                                        // Skip if already complete (static dataset)
                                        try { const comp = isHearingComplete(id); if (comp && comp.complete) continue; } catch {}
                                        await hydrateHearingDirect(id);
                                    } catch {}
                                }
                            });
                            await Promise.all(workers);
                            try {
                                const rows = sqliteDb.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all('afventer konklusion');
                                hearingIndex = (rows || []).map(enrichHearingForIndex);
                            } catch {}
                        } catch {}
                    };
                    setImmediate(() => { run().catch(() => {}); });
                    res.json({ success: true, queued: true });
                } catch (e) {
                    res.status(500).json({ success: false });
                }
            });

            // Jobs cleanup
            const jobCleanupSpec = resolveCronSpec(process.env.CRON_JOBS_CLEANUP, '12 * * * *');
            cron.schedule(jobCleanupSpec, () => {
                try { cleanupOldJobs(); } catch {}
            });

            // Hearing refresh cron job
            const hearingRefreshSpec = resolveCronSpec(process.env.CRON_HEARING_REFRESH, '*/30 * * * *');
            if (hearingRefreshSpec) {
                console.log(`Setting up hearing refresh cron with schedule: ${hearingRefreshSpec}`);
                cron.schedule(hearingRefreshSpec, async () => {
                    try {
                        console.log('[CRON] Starting hearing refresh job');
                        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                        
                        // First, warm the hearing index - this will:
                        // 1. Fetch all hearings from API
                        // 2. Only include ones with status "Afventer konklusion"
                        // 3. Update hearing_index table in SQLite with proper titles
                        await warmHearingIndex();
                        
                        // Then refresh hearings marked as 'Afventer konklusion'
                        if (sqliteDb && sqliteDb.prepare) {
                            const pendingHearings = sqliteDb.prepare(`
                                SELECT id FROM hearings 
                                WHERE archived IS NOT 1 
                                AND LOWER(status) LIKE '%afventer konklusion%'
                                ORDER BY updated_at ASC
                                LIMIT 10
                            `).all();
                            
                            console.log(`[CRON] Found ${pendingHearings.length} pending hearings to refresh`);
                            
                            for (const hearing of pendingHearings) {
                                try {
                                    await axios.post(`${base}/api/prefetch/${hearing.id}?apiOnly=1`, 
                                        { reason: 'cron_refresh' }, 
                                        { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }
                                    );
                                    console.log(`[CRON] Refreshed hearing ${hearing.id}`);
                                } catch (e) {
                                    console.error(`[CRON] Failed to refresh hearing ${hearing.id}:`, e.message);
                                }
                            }
                        }
                        console.log('[CRON] Hearing refresh job completed');
                    } catch (e) {
                        console.error('[CRON] Hearing refresh job failed:', e.message);
                    }
                });
            }
        } catch (e) {
            console.warn('Cron setup failed:', e.message);
        }
    }

    // Resume any dangling jobs from previous run
    try { resumeDanglingJobs(); } catch (e) { console.warn('resumeDanglingJobs failed:', e.message); }
});

// =============================
// Robust refresh for open hearings (materials + responses) with stabilization
// =============================

function statusMatchesRefreshTargets(statusText) {
    const s = String(statusText || '').toLowerCase();
    return REFRESH_TARGET_STATUSES.some(t => s.includes(t));
}

async function fetchAggregateOnce(localBase, hearingId) {
    const aggUrl = `${localBase}/api/hearing/${encodeURIComponent(hearingId)}?nocache=1`;
    const matUrl = `${localBase}/api/hearing/${encodeURIComponent(hearingId)}/materials?nocache=1`;
    const [agg, mats] = await Promise.all([
        axios.get(aggUrl, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }).catch(() => ({ status: 0, data: null })),
        axios.get(matUrl, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }).catch(() => ({ status: 0, data: null }))
    ]);
    const hearing = (agg.data && agg.data.hearing) ? agg.data.hearing : null;
    const responses = (agg.data && Array.isArray(agg.data.responses)) ? agg.data.responses : [];
    const materials = (mats.data && Array.isArray(mats.data.materials)) ? mats.data.materials : [];
    const ok = !!hearing && responses.length >= 0 && materials.length >= 0;
    return { ok, hearing, responses, materials };
}

function snapshotSignature(s) {
    if (!s) return 'x';
    const numR = Array.isArray(s.responses) ? s.responses.length : 0;
    const numM = Array.isArray(s.materials) ? s.materials.length : 0;
    const firstRid = numR ? (s.responses[0]?.id || s.responses[0]?.responseNumber || 0) : 0;
    const lastRid = numR ? (s.responses[numR - 1]?.id || s.responses[numR - 1]?.responseNumber || 0) : 0;
    const firstM = numM ? (s.materials[0]?.title || s.materials[0]?.url || '') : '';
    const lastM = numM ? (s.materials[numM - 1]?.title || s.materials[numM - 1]?.url || '') : '';
    return `${numR}|${firstRid}|${lastRid}::${numM}|${firstM}|${lastM}`;
}

// Hydrate a hearing directly from Bliv hørt (no HTTP calls to our own endpoints)
async function hydrateHearingDirect(hearingId) {
    try {
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': 'kk-xyz=1',
                'Referer': `${baseUrl}/hearing/${hearingId}/comments`,
                'Origin': baseUrl
            },
            timeout: 30000,
            validateStatus: () => true
        });

        // Fetch responses (HTML + JSON API merge)
        let htmlResponses = [];
        let totalPages = 1;
        try {
            const first = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, 1, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            htmlResponses = first.responses || [];
            totalPages = first.totalPages || 1;
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
                // Unknown pages fallback
                let pageIndex = 2;
                let consecutiveEmpty = 0;
                let lastFirstId = htmlResponses[0]?.responseNumber ?? null;
                for (;;) {
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (!pageItems.length) {
                        consecutiveEmpty += 1; if (consecutiveEmpty >= 2) break;
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
        } catch (_) { htmlResponses = []; totalPages = 1; }

        // API fallback for merge
        let viaApi = { responses: [], totalPages: null };
        try { viaApi = await fetchCommentsViaApi(`${baseUrl}/api`, hearingId, axiosInstance); } catch {}
        const merged = mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []);
        const normalizedResponses = normalizeResponses(merged);

        // Meta via root page (__NEXT_DATA__) then JSON API
        let hearingMeta = { title: null, deadline: null, startDate: null, status: null };
        try {
            const rootPage = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            if (rootPage.nextJson) hearingMeta = extractMetaFromNextJson(rootPage.nextJson);
        } catch {}
        if (!hearingMeta.title || !hearingMeta.deadline || !hearingMeta.startDate || !hearingMeta.status) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { headers: { Accept: 'application/json' } });
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
        const hearing = {
            id: Number(hearingId),
            title: hearingMeta.title || `Høring ${hearingId}`,
            startDate: hearingMeta.startDate || null,
            deadline: hearingMeta.deadline || null,
            status: hearingMeta.status || 'ukendt',
            url: `${baseUrl}/hearing/${hearingId}/comments`
        };

        // Materials via root page then JSON API fallback
        let materials = [];
        try {
            const res1 = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            materials = res1.materials || [];
        } catch {}
        if (!materials.length) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { headers: { Accept: 'application/json' } });
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
                            const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g; let m;
                            while ((m = mdLinkRe.exec(text)) !== null) addLink(m[2], m[1]);
                            const urlRe = /(https?:\/\/[^\s)]+)(?![^\[]*\])/g; let u;
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
                    const seen = new Set(); const deduped = [];
                    for (const m of materials) {
                        const key = `${m.type}|${m.title || ''}|${m.url || ''}|${(m.content || '').slice(0,50)}`;
                        if (seen.has(key)) continue; seen.add(key); deduped.push(m);
                    }
                    materials = deduped;
                }
            } catch {}
        }

        try { upsertHearing(hearing); replaceResponses(hearing.id, normalizedResponses); replaceMaterials(hearing.id, materials); } catch {}
        const sig = snapshotSignature({ responses: normalizedResponses, materials });
        try { markHearingComplete(hearing.id, sig, normalizedResponses.length, materials.length); } catch {}
        return { success: true, hearingId: hearing.id, responses: normalizedResponses.length, materials: materials.length };
    } catch (e) {
        return { success: false, error: e && e.message };
    }
}

async function refreshHearingUntilStable(hearingId) {
    // If API-only prefetch is enabled for cron, prefer that to reduce heavy scraping
    if (API_ONLY_PREFETCH) {
        try {
            await axios.post(`${(process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`}/api/prefetch/${encodeURIComponent(hearingId)}?apiOnly=1`, { reason: 'refresh' }, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
            return { success: true };
        } catch {}
    }
    const localBase = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
    let lastSig = '';
    let stableRepeats = 0;
    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
        const snap = await fetchAggregateOnce(localBase, hearingId);
        if (!snap.ok) {
            await sleep(400 * attempt);
            continue;
        }
        if (!statusMatchesRefreshTargets(snap.hearing?.status || '')) {
            return { skipped: true, reason: 'status-mismatch' };
        }
        const sig = snapshotSignature(snap);
        if (sig === lastSig) {
            stableRepeats += 1;
            if (stableRepeats >= REFRESH_STABLE_REPEATS) {
                return { success: true, responses: snap.responses.length, materials: snap.materials.length };
            }
        } else {
            lastSig = sig;
            stableRepeats = 1;
        }
        await sleep(500 * attempt);
    }
    return { success: false };
}

async function listRefreshTargetHearings() {
    let ids = [];
    try {
        ids = hearingIndex
            .filter(h => statusMatchesRefreshTargets(h.status))
            .map(h => h.id);
    } catch {}
    if (!ids.length && sqliteDb && sqliteDb.prepare) {
        try {
            const rows = sqliteDb.prepare(`SELECT id, status FROM hearings`).all();
            ids = rows.filter(r => statusMatchesRefreshTargets(r.status)).map(r => r.id);
        } catch {}
    }
    return Array.from(new Set(ids)).filter(x => Number.isFinite(x));
}

app.post('/api/refresh/open', async (req, res) => {
    try {
        const ids = await listRefreshTargetHearings();
        let idx = 0;
        let completed = 0;
        const results = [];
        const workers = new Array(Math.min(REFRESH_CONCURRENCY, Math.max(1, ids.length))).fill(0).map(async () => {
            while (idx < ids.length) {
                const my = ids[idx++];
                const out = await refreshHearingUntilStable(my);
                results.push({ id: my, ...out });
                completed += 1;
            }
        });
        await Promise.all(workers);
        res.json({ success: true, total: ids.length, refreshed: completed, results });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Refresh failed', error: e.message });
    }
});