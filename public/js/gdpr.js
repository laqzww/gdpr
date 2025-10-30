// Modern notification system - replace alerts with notifications
function showNotification(message, type = 'info') {
    let container = document.getElementById('notifications');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notifications';
        container.style.cssText = `
            position: fixed;
            top: var(--space-lg);
            right: var(--space-lg);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: var(--space-sm);
            max-width: 400px;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }
    
    const notification = document.createElement('div');
    notification.className = `alert alert-${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
    notification.style.cssText = `
        min-width: 300px;
        padding: var(--space-md);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        animation: slideIn 0.3s ease-out;
        cursor: pointer;
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: var(--space-sm);
    `;
    
    const icon = type === 'error' ? '⚠️' : type === 'success' ? '✓' : 'ℹ️';
    notification.innerHTML = `
        <span style="font-size: 1.2em;">${icon}</span>
        <span style="flex: 1;">${message}</span>
        <button style="background: transparent; border: none; cursor: pointer; font-size: 1.2em; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;" onclick="this.parentElement.remove()">×</button>
    `;
    
    notification.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
            notification.style.animation = 'slideOut 0.2s ease-in';
            setTimeout(() => notification.remove(), 200);
        }
    });
    
    container.appendChild(notification);
    
    if (type !== 'error') {
        setTimeout(() => {
            if (notification.parentElement) {
                notification.style.animation = 'slideOut 0.3s ease-in';
                setTimeout(() => notification.remove(), 300);
            }
        }, 5000);
    }
}

function showError(message) {
    showNotification(message, 'error');
}

function showSuccess(message) {
    showNotification(message, 'success');
}

function showInfo(message) {
    showNotification(message, 'info');
}

// Add CSS animations if not already present
if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(100%);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);
}

const hearingListEl = document.getElementById('hearing-list');
const detailEl = document.getElementById('gdpr-detail');
const hearingCountEl = document.getElementById('hearing-count');
const searchInput = document.getElementById('hearing-search');

const templates = {
    rawResponse: document.getElementById('raw-response-template'),
    preparedResponse: document.getElementById('prepared-response-template'),
    attachment: document.getElementById('attachment-template'),
    material: document.getElementById('material-template')
};

const state = {
    hearings: [],
    currentId: null,
    detail: null,
    loading: false,
    searchTerm: '',
    filters: {}
};

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        const message = data.error || data.message || response.statusText;
        throw new Error(message || 'Ukendt fejl');
    }
    return data;
}

function formatStatusPill(status) {
    const normalized = String(status || 'draft').toLowerCase();
    if (normalized === 'published') return { text: 'Publiceret', className: 'status-pill ready' };
    if (normalized === 'ready') return { text: 'Klar til publicering', className: 'status-pill ready' };
    if (normalized === 'in-progress') return { text: 'I arbejde', className: 'status-pill progress' };
    return { text: 'Klargøring mangler', className: 'status-pill draft' };
}

function setLoading(flag) {
    state.loading = flag;
    if (flag) detailEl.classList.add('is-loading');
    else detailEl.classList.remove('is-loading');
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateDisplay(value) {
    const date = parseDate(value);
    if (!date) return value || 'ukendt';
    return date.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDeadlineShort(value) {
    const date = parseDate(value);
    if (!date) return 'Ingen frist';
    return date.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDeadline(value) {
    return value ? formatDeadlineShort(value) : 'ukendt';
}

if (searchInput) {
    searchInput.addEventListener('input', (event) => {
        state.searchTerm = event.target.value || '';
        renderHearingList();
    });
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            state.searchTerm = '';
            event.target.value = '';
            renderHearingList();
            event.target.blur();
        }
    });
}

async function loadHearings() {
    try {
        const data = await fetchJson('/api/gdpr/hearings');
        state.hearings = data.hearings || [];
        renderHearingList();
    } catch (error) {
        console.error('Kunne ikke hente hearings', error);
        hearingListEl.innerHTML = `<div class="list-empty">Fejl: ${error.message}</div>`;
    }
}

function renderHearingList() {
    const total = state.hearings.length;
    const term = (state.searchTerm || '').trim().toLowerCase();
    const filtered = !term ? state.hearings : state.hearings.filter((hearing) => {
        const title = String(hearing.title || '').toLowerCase();
        const idMatch = String(hearing.hearingId || hearing.id || '').includes(term);
        const statusText = String(hearing.status || '').toLowerCase();
        return title.includes(term) || idMatch || statusText.includes(term);
    });
    const count = filtered.length;
    hearingCountEl.textContent = count;
    hearingCountEl.title = count === total
        ? `Viser ${total} høringer`
        : `Viser ${count} af ${total} høringer`;
    if (!count) {
        hearingListEl.innerHTML = state.searchTerm
            ? '<div class="list-empty">Ingen høringer matcher din søgning</div>'
            : '<div class="list-empty">Ingen høringer fundet</div>';
        return;
    }
    hearingListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const hearing of filtered) {
        const item = document.createElement('div');
        item.className = 'hearing-item';
        if (Number(state.currentId) === Number(hearing.hearingId)) item.classList.add('active');
        const statusPill = formatStatusPill(hearing.preparation?.status);
        const rawCount = hearing.counts?.rawResponses ?? 0;
        const preparedCount = hearing.counts?.preparedResponses ?? 0;
        const publishedCount = hearing.counts?.publishedResponses ?? 0;
        item.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:4px;">
                <strong>${hearing.title || `Høring ${hearing.hearingId}`}</strong>
                <div style="display:flex;flex-direction:column;gap:2px;font-size:var(--font-size-sm);color:var(--color-gray-600);">
                    <span>Deadline: ${formatDeadline(hearing.deadline)}</span>
                </div>
                <div class="pill-group">
                    <span class="${statusPill.className}">${statusPill.text}</span>
                    ${hearing.preparation?.responsesReady ? '<span class="status-pill ready">Svar klar</span>' : ''}
                    ${hearing.preparation?.materialsReady ? '<span class="status-pill ready">Materiale klar</span>' : ''}
                </div>
            </div>
        `;
        item.dataset.hearingId = hearing.hearingId;
        fragment.appendChild(item);
    }
    hearingListEl.appendChild(fragment);
}

async function selectHearing(hearingId) {
    if (!hearingId) return;
    state.currentId = hearingId;
    renderHearingList();
    await loadHearingDetail(hearingId);
}

async function loadHearingDetail(hearingId) {
    setLoading(true);
    try {
        const data = await fetchJson(`/api/gdpr/hearing/${hearingId}`);
        state.detail = data;
        renderHearingDetail();
    } catch (error) {
        console.error('Kunne ikke hente detaljer', error);
        detailEl.innerHTML = `<div class="detail-section"><h2>Fejl</h2><p>${error.message}</p></div>`;
    } finally {
        setLoading(false);
    }
}

function createCardFromTemplate(selector) {
    const tpl = templates[selector];
    return tpl ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('div');
}

function renderStateSection(detail) {
    const status = formatStatusPill(detail.state?.status);
    const responsesReady = detail.state?.responses_ready || detail.state?.responsesReady;
    const materialsReady = detail.state?.materials_ready || detail.state?.materialsReady;
    const publishedAt = detail.state?.published_at || detail.state?.publishedAt;
    const counts = {
        raw: detail.raw?.responses?.length || 0,
        prepared: detail.prepared?.responses?.length || 0,
        published: detail.published?.responses?.length || 0,
        approved: (detail.prepared?.responses || []).filter(r => r.approved).length
    };
    const materialsCount = {
        raw: detail.raw?.materials?.length || 0,
        prepared: detail.prepared?.materials?.length || 0,
        published: detail.published?.materials?.length || 0,
        approved: (detail.prepared?.materials || []).filter(m => m.approved).length
    };
    return `
        <div class="detail-section" data-role="state">
            <h2>${detail.hearing?.title || `Høring ${detail.hearing?.id}`}</h2>
            <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap;">
                <span class="${status.className}">${status.text}</span>
                <span class="status-pill ${counts.approved === counts.raw && counts.raw > 0 ? 'ready' : 'progress'}" title="Godkendte svar er klar til publicering. Rå svar er de originale fra blivhørt.">Svar godkendt: ${counts.approved}/${counts.raw}</span>
                <span class="status-pill ${materialsCount.approved === materialsCount.raw && materialsCount.raw > 0 ? 'ready' : 'progress'}">Materiale godkendt: ${materialsCount.approved}/${materialsCount.raw}</span>
                <span class="status-pill ready">Publicerede svar: ${counts.published}/${counts.raw}</span>
                <span class="status-pill ready">Publicerede materialer: ${materialsCount.published}/${materialsCount.raw}</span>
                ${publishedAt ? `<span class="status-pill ready">Publiceret ${formatDateDisplay(publishedAt)}</span>` : ''}
            </div>
            <div style="margin-top:var(--space-sm);display:grid;gap:var(--space-xs);font-size:var(--font-size-sm);color:var(--color-gray-600);">
                <span>Deadline: ${formatDeadline(detail.hearing?.deadline)}</span>
                <span>Status: ${detail.hearing?.status || 'ukendt'}</span>
            </div>
        </div>
    `;
}

function renderRawResponses(detail) {
    // Only show prepared responses - no raw responses display
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'prepared-responses-only';
    wrapper.innerHTML = `
        <h2>Høringssvar</h2>
        <p style="margin-top:var(--space-xs);color:var(--color-gray-600);font-size:var(--font-size-sm);">
            Redigér den klargjorte kopi og gem dine ændringer. Svar markeres automatisk som klargjort når der gemmes. Eller nulstil til den oprindelige version.
        </p>
    `;
    const list = document.createElement('div');
    list.className = 'card-list';
    const preparedResponses = detail.prepared?.responses || [];
    const rawResponses = detail.raw?.responses || [];
    const usedPreparedIds = new Set();

    // Calculate svarnummer based on all prepared responses (not filtered)
    const allPreparedSorted = [...preparedResponses].sort((a, b) => {
        const aId = Number(a.preparedId);
        const bId = Number(b.preparedId);
        return aId - bId;
    });
    const svarnummerMap = new Map();
    allPreparedSorted.forEach((p, idx) => {
        svarnummerMap.set(Number(p.preparedId), idx + 1);
    });

    // If no prepared responses exist but raw responses do, show message
    if (!preparedResponses.length && rawResponses.length) {
        list.innerHTML = '<div class="list-empty">Ingen klargjorte svar endnu. Klik på "Fuld nulstil" for at oprette klargjorte svar fra de originale høringssvar.</div>';
    } else if (!preparedResponses.length && !rawResponses.length) {
        list.innerHTML = '<div class="list-empty">Ingen svar hentet fra blivhørt endnu.</div>';
    } else {
        // Show all prepared responses (only one per raw response should exist)
        preparedResponses.forEach((prepared) => {
            const svarnummer = svarnummerMap.get(Number(prepared.preparedId)) || 0;
            const preparedCard = createPreparedResponseCard(prepared, svarnummer);
            list.appendChild(preparedCard);
            usedPreparedIds.add(Number(prepared.preparedId));
        });
    }
    wrapper.appendChild(list);
    wrapper.usedPreparedIds = usedPreparedIds;
    return wrapper;
}

function createBadge(text) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = text;
    return span;
}

function createPreparedResponseCard(prepared, svarnummer = null) {
    const card = createCardFromTemplate('preparedResponse');
    card.dataset.preparedId = prepared.preparedId;
    const title = card.querySelector('.title-group');
    const svarnummerText = svarnummer ? `Svarnummer ${svarnummer}` : `Svarnummer ${prepared.preparedId}`;
    title.innerHTML = `<strong>${svarnummerText}</strong>
        <div class="pill-group" style="margin-top:var(--space-xs);">
            <div style="display:flex;gap:var(--space-sm);align-items:center;flex-wrap:wrap;">
                <label style="display:flex;gap:var(--space-xs);align-items:center;font-size:var(--font-size-sm);">
                    <span>Navn:</span>
                    <input type="text" data-role="respondent-name" value="${prepared.respondentName || 'Borger'}" style="padding:var(--space-xs);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);" placeholder="Borger">
                </label>
                <label style="display:flex;gap:var(--space-xs);align-items:center;font-size:var(--font-size-sm);">
                    <span>Type:</span>
                    <select data-role="respondent-type" style="padding:var(--space-xs);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);">
                        <option value="Borger" ${(prepared.respondentType || 'Borger') === 'Borger' ? 'selected' : ''}>Borger</option>
                        <option value="Organisation" ${prepared.respondentType === 'Organisation' ? 'selected' : ''}>Organisation</option>
                        <option value="Myndighed" ${prepared.respondentType === 'Myndighed' ? 'selected' : ''}>Myndighed</option>
                        <option value="Politisk parti" ${prepared.respondentType === 'Politisk parti' ? 'selected' : ''}>Politisk parti</option>
                    </select>
                </label>
            </div>
            ${prepared.hasAttachments ? '<span class="badge" style="margin-top:var(--space-xs);">Vedhæftninger</span>' : ''}
        </div>`;
    const approvedCheckbox = card.querySelector('[data-role="approved"]');
    approvedCheckbox.checked = !!prepared.approved;
    const textArea = card.querySelector('textarea[data-role="text"]');
    textArea.value = prepared.textMd || prepared.text || '';
    const saveBtn = card.querySelector('[data-action="save"]');
    saveBtn.dataset.preparedId = prepared.preparedId;
    const resetBtn = card.querySelector('[data-action="reset-prepared"]');
    if (resetBtn) {
        resetBtn.dataset.preparedId = prepared.preparedId;
        if (!prepared.sourceResponseId) {
            resetBtn.disabled = true;
            resetBtn.title = 'Ingen tilknyttet original at nulstille til';
        }
    }
    const attachmentsContainer = card.querySelector('.attachments');
    attachmentsContainer.innerHTML = '';
    if (Array.isArray(prepared.attachments) && prepared.attachments.length) {
        prepared.attachments.forEach((att) => {
            const attCard = createCardFromTemplate('attachment');
            attCard.dataset.attachmentId = att.attachmentId;
            attCard.dataset.preparedId = prepared.preparedId;
            attCard.querySelector('.attachment-title').textContent = att.originalFilename || `Bilag ${att.attachmentId}`;
            const convertBtn = attCard.querySelector('[data-action="convert"]');
            convertBtn.dataset.attachmentId = att.attachmentId;
            convertBtn.dataset.preparedId = prepared.preparedId;
            if (att.sourceAttachmentIdx !== undefined && att.sourceAttachmentIdx !== null) {
                convertBtn.dataset.sourceIdx = att.sourceAttachmentIdx;
            }
            const saveAttachmentBtn = attCard.querySelector('[data-action="save-attachment"]');
            saveAttachmentBtn.dataset.attachmentId = att.attachmentId;
            saveAttachmentBtn.dataset.preparedId = prepared.preparedId;
            const attApproved = attCard.querySelector('[data-role="attachment-approved"]');
            attApproved.checked = !!att.approved;
            attApproved.dataset.attachmentId = att.attachmentId;
            attApproved.dataset.preparedId = prepared.preparedId;
            const attTextarea = attCard.querySelector('[data-role="attachment-text"]');
            attTextarea.value = att.convertedMd || '';
            attTextarea.dataset.attachmentId = att.attachmentId;
            attTextarea.dataset.preparedId = prepared.preparedId;
            attachmentsContainer.appendChild(attCard);
        });
    }
    return card;
}

function renderPreparedResponses(detail, skipSet = new Set()) {
    const responses = (detail.prepared?.responses || []).filter((resp) => !skipSet.has(Number(resp.preparedId)));
    if (!responses.length) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'prepared-responses';
    wrapper.innerHTML = '<h2>Klargjorte høringssvar uden original</h2>';
    const list = document.createElement('div');
    list.className = 'card-list';

    const allPreparedSorted = [...responses].sort((a, b) => {
        const aId = Number(a.preparedId);
        const bId = Number(b.preparedId);
        return aId - bId;
    });
    const svarnummerMap = new Map();
    allPreparedSorted.forEach((p, idx) => {
        svarnummerMap.set(Number(p.preparedId), idx + 1);
    });

    responses.forEach((resp) => {
        const svarnummer = svarnummerMap.get(Number(resp.preparedId)) || 0;
        const card = createPreparedResponseCard(resp, svarnummer);
        list.appendChild(card);
    });

    wrapper.appendChild(list);
    return wrapper;
}

function renderMaterials(detail) {
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'materials';
    wrapper.innerHTML = `
        <h2>Høringsmateriale</h2>
        <div class="material-upload">
            <input type="file" id="material-upload" accept=".pdf,.md,.markdown,.txt">
            <button class="btn btn-secondary" data-action="refresh-materials">Opdater</button>
        </div>
    `;
    const list = document.createElement('div');
    list.className = 'card-list';
    const materials = detail.prepared?.materials || [];
    if (!materials.length) {
        list.innerHTML = '<div class="list-empty">Ingen klargjorte materialer endnu.</div>';
    } else {
        materials.forEach((mat) => {
            const card = createCardFromTemplate('material');
            card.dataset.materialId = mat.materialId;
            card.querySelector('.material-title').textContent = mat.title || `Materiale ${mat.materialId}`;
            const badges = card.querySelector('[data-role="material-badges"]');
            if (mat.sourceFilename) badges.appendChild(createBadge(mat.sourceFilename));
            const approvedCheckbox = card.querySelector('[data-role="material-approved"]');
            approvedCheckbox.checked = !!mat.approved;
            approvedCheckbox.dataset.materialId = mat.materialId;
            const textArea = card.querySelector('[data-role="material-text"]');
            textArea.value = mat.contentMd || '';
            textArea.dataset.materialId = mat.materialId;
            const saveBtn = card.querySelector('[data-action="save-material"]');
            saveBtn.dataset.materialId = mat.materialId;
            const deleteBtn = card.querySelector('[data-action="delete-material"]');
            deleteBtn.dataset.materialId = mat.materialId;
            list.appendChild(card);
        });
    }
    wrapper.appendChild(list);
    return wrapper;
}

function renderPublishedSection(detail) {
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'published';
    const responses = detail.published?.responses || [];
    const materials = detail.published?.materials || [];
    wrapper.innerHTML = `
        <h2>Publiceret</h2>
        <p>Publicerede svar: ${responses.length}. Publicerede materialer: ${materials.length}.</p>
    `;
    return wrapper;
}

function renderFooter(detail) {
    const counts = {
        raw: detail.raw?.responses?.length || 0,
        approved: (detail.prepared?.responses || []).filter(r => r.approved).length
    };
    const materialsCount = {
        raw: detail.raw?.materials?.length || 0,
        approved: (detail.prepared?.materials || []).filter(m => m.approved).length
    };
    
    let footerEl = document.getElementById('publish-footer');
    if (!footerEl) {
        footerEl = document.createElement('div');
        footerEl.id = 'publish-footer';
        footerEl.className = 'publish-footer';
        document.body.appendChild(footerEl);
    }
    
    const readyCount = counts.approved + materialsCount.approved;
    footerEl.innerHTML = `
        <div class="publish-footer-content">
            <div class="publish-footer-info">
                <div class="publish-footer-text">
                    ${readyCount} godkendt${readyCount !== 1 ? 'e' : ''} element${readyCount !== 1 ? 'er' : ''} klar til publicering
                </div>
                <div class="publish-footer-hint">
                    Kun godkendte svar og materiale vil blive publiceret
                </div>
            </div>
            <button id="publish-btn-footer" class="btn btn-primary publish-footer-btn">Publicer alle godkendte</button>
        </div>
    `;
    
    const footerBtn = footerEl.querySelector('#publish-btn-footer');
    if (footerBtn) {
        footerBtn.addEventListener('click', handlePublish);
    }
}

async function handleSavePrepared(preparedId) {
    if (!state.detail || !state.currentId) return;
    const card = detailEl.querySelector(`.prepared-response[data-prepared-id="${preparedId}"]`);
    if (!card) return;
    const textArea = card.querySelector('textarea[data-role="text"]');
    const approvedCheckbox = card.querySelector('[data-role="approved"]');
    const respondentNameInput = card.querySelector('[data-role="respondent-name"]');
    const respondentTypeSelect = card.querySelector('[data-role="respondent-type"]');
    const prepared = (state.detail.prepared?.responses || []).find(r => Number(r.preparedId) === Number(preparedId));
    if (!prepared) return;
    try {
        // Auto-approve when saving
        const now = Date.now();
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                preparedId,
                sourceResponseId: prepared.sourceResponseId ?? null,
                respondentName: respondentNameInput ? respondentNameInput.value : (prepared.respondentName ?? 'Borger'),
                respondentType: respondentTypeSelect ? respondentTypeSelect.value : (prepared.respondentType ?? 'Borger'),
                author: prepared.author ?? null,
                organization: prepared.organization ?? null,
                onBehalfOf: prepared.onBehalfOf ?? null,
                submittedAt: prepared.submittedAt ?? null,
                textMd: textArea.value,
                hasAttachments: prepared.hasAttachments,
                attachmentsReady: prepared.attachmentsReady,
                approved: true,
                approvedAt: now,
                notes: prepared.notes ?? null
            })
        });
        approvedCheckbox.checked = true;
        await loadHearingDetail(state.currentId);
        showSuccess('Svar gemt og godkendt.');
    } catch (error) {
        showError(`Fejl ved gem af svar: ${error.message}`);
    }
}

async function handleSaveAttachment(preparedId, attachmentId) {
    const container = detailEl.querySelector(`.attachment-block[data-attachment-id="${attachmentId}"][data-prepared-id="${preparedId}"]`) || detailEl.querySelector(`.attachment-block[data-prepared-id="${preparedId}"]`);
    const parentCard = detailEl.querySelector(`.prepared-response[data-prepared-id="${preparedId}"]`);
    if (!container || !parentCard) return;
    const textArea = container.querySelector('[data-role="attachment-text"]');
    const approvedCheckbox = container.querySelector('[data-role="attachment-approved"]');
    try {
        // Auto-approve when saving
        const now = Date.now();
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                attachmentId,
                convertedMd: textArea.value,
                approved: true,
                approvedAt: now,
                conversionStatus: 'manual-edit'
            })
        });
        approvedCheckbox.checked = true;
        await loadHearingDetail(state.currentId);
        showSuccess('Vedhæftning gemt og godkendt.');
    } catch (error) {
        showError(`Fejl ved gem af vedhæftning: ${error.message}`);
    }
}

async function handleConvertAttachment(preparedId, attachmentId, sourceIdx) {
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments/${attachmentId}/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawAttachmentIdx: sourceIdx })
        });
        await loadHearingDetail(state.currentId);
        showSuccess('Vedhæftning konverteret.');
    } catch (error) {
        showError(`Konvertering mislykkedes: ${error.message}`);
    }
}

async function handleSaveMaterial(materialId) {
    const card = detailEl.querySelector(`.material-item[data-material-id="${materialId}"]`);
    if (!card) return;
    const textArea = card.querySelector('[data-role="material-text"]');
    const approvedCheckbox = card.querySelector('[data-role="material-approved"]');
    const material = (state.detail.prepared?.materials || []).find(m => Number(m.materialId) === Number(materialId));
    if (!material) return;
    try {
        // Auto-approve when saving
        const now = Date.now();
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                materialId,
                title: material.title,
                sourceFilename: material.sourceFilename,
                sourceUrl: material.sourceUrl,
                uploadedPath: material.uploadedPath,
                contentMd: textArea.value,
                approved: true,
                approvedAt: now
            })
        });
        approvedCheckbox.checked = true;
        await loadHearingDetail(state.currentId);
        showSuccess('Materiale gemt og godkendt.');
    } catch (error) {
        showError(`Fejl ved gem af materiale: ${error.message}`);
    }
}

async function handleDeleteMaterial(materialId) {
    if (!confirm('Slet dette materiale?')) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials/${materialId}`, { method: 'DELETE' });
        await loadHearingDetail(state.currentId);
        showSuccess('Materiale slettet.');
    } catch (error) {
        showError(`Kunne ikke slette materiale: ${error.message}`);
    }
}

async function handleUploadMaterial(file) {
    if (!file) return;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const uploadRes = await fetch(`/api/gdpr/hearing/${state.currentId}/materials/upload`, {
            method: 'POST',
            body: formData
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok || uploadData.success === false) {
            throw new Error(uploadData.error || uploadData.message || 'Upload mislykkedes');
        }
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: uploadData.originalName,
                sourceFilename: uploadData.originalName,
                uploadedPath: uploadData.storedPath,
                contentMd: uploadData.contentMd,
                approved: false
            })
        });
        await loadHearingDetail(state.currentId);
        showSuccess('Fil uploadet.');
    } catch (error) {
        showError(`Filupload mislykkedes: ${error.message}`);
    }
}

async function handlePublish() {
    if (!state.currentId) return;
    const confirmPublish = confirm('Vil du publicere alle godkendte svar og materiale? Kun godkendte elementer vil blive publiceret.');
    if (!confirmPublish) return;
    try {
        // Always publish only approved (onlyApproved defaults to true)
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ onlyApproved: true })
        });
        await Promise.all([loadHearings(), loadHearingDetail(state.currentId)]);
        showSuccess('Høringen er publiceret til hovedsiden. Kun godkendte svar og materiale er blevet publiceret.');
    } catch (error) {
        showError(`Kunne ikke publicere: ${error.message}`);
    }
}

async function handleRebuildVector() {
    if (!state.currentId) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/vector-store/rebuild`, { method: 'POST' });
        await loadHearingDetail(state.currentId);
        showSuccess('Kontekst er genopbygget.');
    } catch (error) {
        showError(`Kunne ikke genopbygge kontekst: ${error.message}`);
    }
}

async function handleResetPrepared(preparedId) {
    if (!state.currentId || !preparedId) return;
    const confirmReset = confirm('Nulstil dette høringssvar til den originale tekst fra blivhørt?');
    if (!confirmReset) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/reset`, { method: 'POST' });
        await loadHearingDetail(state.currentId);
        showSuccess('Svar nulstillet til original.');
    } catch (error) {
        showError(`Kunne ikke nulstille svaret: ${error.message}`);
    }
}

async function handleResetHearing() {
    if (!state.currentId) return;
    const confirmReset = confirm('Dette nulstiller alle klargjorte svar og materiale og henter de originale høringssvar og materiale igen fra blivhørt. Vil du fortsætte?');
    if (!confirmReset) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/reset`, { method: 'POST' });
        await Promise.all([loadHearings(), loadHearingDetail(state.currentId)]);
        showSuccess('Høringen er nulstillet. De originale høringssvar og materiale er hentet igen fra blivhørt.');
    } catch (error) {
        showError(`Kunne ikke nulstille høringen: ${error.message}`);
    }
}

hearingListEl.addEventListener('click', (event) => {
    const item = event.target.closest('.hearing-item');
    if (!item) return;
    const id = Number(item.dataset.hearingId);
    if (id) selectHearing(id);
});

detailEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'save') {
        const preparedId = Number(button.dataset.preparedId);
        if (preparedId) await handleSavePrepared(preparedId);
    }
    if (action === 'reset-prepared') {
        const preparedId = Number(button.dataset.preparedId);
        if (preparedId) await handleResetPrepared(preparedId);
    }
    if (action === 'save-attachment') {
        const preparedId = Number(button.dataset.preparedId);
        const attachmentId = Number(button.dataset.attachmentId);
        if (preparedId && attachmentId) await handleSaveAttachment(preparedId, attachmentId);
    }
    if (action === 'convert') {
        const preparedId = Number(button.dataset.preparedId);
        const attachmentId = Number(button.dataset.attachmentId);
        const sourceIdx = button.dataset.sourceIdx !== undefined ? Number(button.dataset.sourceIdx) : null;
        if (preparedId && attachmentId) await handleConvertAttachment(preparedId, attachmentId, sourceIdx);
    }
    if (action === 'save-material') {
        const materialId = Number(button.dataset.materialId);
        if (materialId) await handleSaveMaterial(materialId);
    }
    if (action === 'delete-material') {
        const materialId = Number(button.dataset.materialId);
        if (materialId) await handleDeleteMaterial(materialId);
    }
    if (action === 'rebuild-vector') {
        await handleRebuildVector();
    }
    if (action === 'reset-hearing') {
        await handleResetHearing();
    }
    if (button.id === 'publish-btn') {
        await handlePublish();
    }
    if (action === 'refresh-materials') {
        await loadHearingDetail(state.currentId);
    }
});

detailEl.addEventListener('change', async (event) => {
    const input = event.target;
    if (input.id === 'material-upload' && input.files?.length) {
        const file = input.files[0];
        await handleUploadMaterial(file);
        input.value = '';
    }
});

async function init() {
    // Don't auto-load hearings - user must use settings modal to search and fetch
    if (state.hearings.length === 0) {
        detailEl.innerHTML = `
            <div class="detail-section">
                <h2>Ingen høringer</h2>
                <p>Brug indstillinger (⚙️) for at søge og hente høringer.</p>
            </div>
        `;
    }
}

init().catch(error => {
    console.error('Initialisering fejlede', error);
});

