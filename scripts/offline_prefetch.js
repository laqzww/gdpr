#!/usr/bin/env node
/*
 Offline prefetch to refresh persisted hearing data without starting the server.
 Mirrors the server.js API-only logic to fetch meta and responses from blivhoert.kk.dk
 Writes files to data/hearings/<id>.json
*/
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function fixEncoding(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\uFFFD/g, '')
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

async function getHearingMeta(id) {
  const baseUrl = 'https://blivhoert.kk.dk';
  // Try API first
  try {
    const r = await axios.get(`${baseUrl}/api/hearing/${id}`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (r.status === 200 && r.data) {
      const data = r.data;
      const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
      const included = Array.isArray(data?.included) ? data.included : [];
      const contents = included.filter(x => x?.type === 'content');
      let title = null;
      const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
      if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
      const attrs = item?.attributes || {};
      const statusRelId = item?.relationships?.hearingStatus?.data?.id;
      const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
      const status = statusIncluded?.attributes?.name || null;
      return {
        id: Number(id),
        title: title || (attrs.title ? fixEncoding(String(attrs.title).trim()) : `Høring ${id}`),
        startDate: attrs.startDate || null,
        deadline: attrs.deadline || null,
        status: status || 'ukendt',
        url: `${baseUrl}/hearing/${id}/comments`
      };
    }
  } catch (_) {}
  // Fallback minimal
  return { id: Number(id), title: `Høring ${id}`, startDate: null, deadline: null, status: 'ukendt', url: `${baseUrl}/hearing/${id}/comments` };
}

async function mapCommentsFromJsonApi(comments, included, baseUrl) {
  const contentById = new Map();
  included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
  const userById = new Map();
  included.filter(x => x?.type === 'user').forEach(u => userById.set(String(u.id), u));

  function resolveAttachment(ref) {
    try {
      const cid = ref?.id && String(ref.id);
      if (!cid || !contentById.has(cid)) return null;
      const c = contentById.get(cid);
      const a = c?.attributes || {};
      const filePath = String(a.filePath || '').trim();
      const fileName = String(a.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
      if (!filePath) return null;
      const qs = new URLSearchParams();
      qs.set('path', filePath);
      qs.set('filename', fileName);
      return { filename: fileName, url: `/api/file-proxy?${qs.toString()}` };
    } catch { return null; }
  }

  const out = [];
  for (const it of comments || []) {
    try {
      if (!it || it.type !== 'comment') continue;
      const attrs = it.attributes || {};
      // withdrawn comments have empty content and should be skipped
      if (attrs.withdrawn) continue;
      const responseNumber = Number(attrs.responseNumber || attrs.commentNumber || out.length + 1);
      const contentRefs = Array.isArray(it.relationships?.contents?.data) ? it.relationships.contents.data : [];
      let text = '';
      const attachments = [];
      for (const cref of contentRefs) {
        const resolved = resolveAttachment(cref);
        if (resolved) attachments.push(resolved);
        const cid = cref?.id && String(cref.id);
        const c = cid && contentById.get(cid);
        const a = c?.attributes || {};
        if (typeof a.textContent === 'string' && a.textContent.trim()) {
          text += (text ? '\n\n' : '') + String(a.textContent).trim();
        }
      }
      const author = (() => {
        const uid = it.relationships?.createdBy?.data?.id && String(it.relationships.createdBy.data.id);
        const u = uid && userById.get(uid);
        return u?.attributes?.name || null;
      })();
      const authorAddress = attrs.address || null;
      const organization = attrs.organization || null;
      const onBehalfOf = attrs.onBehalfOf || null;
      const submittedAt = attrs.created || null;
      if (text.trim().length === 0 && attachments.length === 0) continue;
      out.push({ responseNumber, text: fixEncoding(text), author, authorAddress, organization, onBehalfOf, submittedAt, attachments });
    } catch {}
  }
  return out;
}

async function fetchCommentsViaApi(baseUrl, hearingId) {
  const all = [];
  let totalPages = null;
  const url = `${baseUrl}/api/hearing/${hearingId}/comment`;
  const maxPages = 100;
  async function fetchPage(idx, paramKey) {
    return axios.get(url, {
      validateStatus: () => true,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      params: { include: 'Contents,Contents.ContentType', [paramKey]: idx }
    });
  }
  let paramKey = 'Page';
  let resp = await fetchPage(1, 'Page');
  let items = Array.isArray(resp?.data?.data) ? resp.data.data : [];
  if (resp.status !== 200 || items.length === 0) {
    const respAlt = await fetchPage(1, 'PageIndex');
    const itemsAlt = Array.isArray(respAlt?.data?.data) ? respAlt.data.data : [];
    if (respAlt.status === 200 && itemsAlt.length > 0) { paramKey = 'PageIndex'; resp = respAlt; items = itemsAlt; }
  }
  if (resp?.status !== 200 || !resp?.data) return { responses: [], totalPages: null };
  const includedFirst = Array.isArray(resp?.data?.included) ? resp.data.included : [];
  const pageResponsesFirst = await mapCommentsFromJsonApi(items, includedFirst, baseUrl.replace('/api', ''));
  totalPages = resp?.data?.meta?.Pagination?.totalPages || null;
  if (Array.isArray(pageResponsesFirst) && pageResponsesFirst.length) all.push(...pageResponsesFirst);
  let consecutiveEmpty = 0;
  const lastPage = Number.isFinite(totalPages) && totalPages > 0 ? Math.min(totalPages, maxPages) : maxPages;
  for (let pageIndex = 2; pageIndex <= lastPage; pageIndex += 1) {
    const r = await fetchPage(pageIndex, paramKey);
    if (r.status !== 200 || !r.data) { consecutiveEmpty += 1; if (consecutiveEmpty >= 2 && !Number.isFinite(totalPages)) break; else continue; }
    const itemsN = Array.isArray(r?.data?.data) ? r.data.data : [];
    const includedN = Array.isArray(r?.data?.included) ? r.data.included : [];
    const pageResponses = await mapCommentsFromJsonApi(itemsN, includedN, baseUrl.replace('/api', ''));
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

function normalizeResponses(responses) {
  const cleaned = (responses || [])
    .filter(r => r && (typeof r.responseNumber === 'number' || typeof r.responseNumber === 'string'))
    .map(r => ({
      id: Number(r.responseNumber),
      text: r.text || '',
      author: r.author || null,
      authorAddress: r.authorAddress || null,
      organization: r.organization || null,
      onBehalfOf: r.onBehalfOf || null,
      submittedAt: r.submittedAt || null,
      attachments: Array.isArray(r.attachments) ? r.attachments.map(a => ({ filename: a.filename || (a.url ? String(a.url).split('/').pop() : 'Dokument'), url: a.url })) : []
    }));
  cleaned.sort((a, b) => (a.id || 0) - (b.id || 0));
  return cleaned;
}

async function run(ids) {
  const baseUrl = 'https://blivhoert.kk.dk';
  for (const id of ids) {
    const hearing = await getHearingMeta(id).catch(() => ({ id: Number(id), title: `Høring ${id}`, startDate: null, deadline: null, status: 'ukendt', url: `${baseUrl}/hearing/${id}/comments` }));
    const viaApi = await fetchCommentsViaApi(baseUrl, id).catch(() => ({ responses: [], totalPages: null }));
    const normalized = normalizeResponses(viaApi.responses || []);
    const payload = {
      updatedAt: new Date().toISOString(),
      success: true,
      hearing,
      totalPages: viaApi.totalPages || undefined,
      totalResponses: normalized.length,
      responses: normalized,
      materials: []
    };
    const dir = path.join(__dirname, '..', 'data', 'hearings');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const outPath = path.join(dir, `${id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Updated ${outPath} (${normalized.length} responses)`);
  }
}

const args = process.argv.slice(2).filter(Boolean);
const ids = args.length ? args : ['201', '223'];
run(ids).catch(e => { console.error(e); process.exit(1); });

