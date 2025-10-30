// Modern notification system - replace alerts with notifications
function showNotification(message, type = 'info') {
    // Get or create notifications container
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
    
    // Click to dismiss
    notification.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
            notification.style.animation = 'slideOut 0.2s ease-in';
            setTimeout(() => notification.remove(), 200);
        }
    });
    
    container.appendChild(notification);
    
    // Auto-dismiss after 5 seconds for non-error notifications; errors remain until clicked
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

if (!hearingListEl || !detailEl || !hearingCountEl) {
    console.error('Kritiske DOM-elementer mangler:', { hearingListEl, detailEl, hearingCountEl });
}

const templates = {
    rawResponse: document.getElementById('raw-response-template'),
    preparedResponse: document.getElementById('prepared-response-template'),
    attachment: document.getElementById('attachment-template'),
    material: document.getElementById('material-template')
};

const RESPONDENT_TYPES = [
    'Borger', 'Interesseorganisation', 'Lokaludvalg', 'Offentlig myndighed', 'Beboergruppe'
];

const state = {
    hearings: [],
    currentId: null,
    detail: null,
    loading: false,
    searchTerm: '',
    filters: {
        approved: 'all', // 'all', 'approved', 'not-approved'
        published: 'all', // 'all', 'published', 'not-published'
        hasAttachments: 'all', // 'all', 'yes', 'no'
        organization: '' // filter by organization name
    }
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

function formatDeadline(value) {
    return value ? formatDateDisplay(value) : 'ukendt';
}

function formatDeadlineShort(value) {
    const date = parseDate(value);
    if (!date) return 'Ingen frist';
    return date.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
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
} else {
    console.warn('searchInput ikke fundet');
}

// Settings modal
let settingsBtn, settingsModal, settingsCloseBtn, hearingSearchInput, hearingSearchSuggestions;

let searchTimeout;
let cachedSearchIndex = null;
let lastIndexFetch = 0;
const INDEX_CACHE_TIME = 0;
let currentSearchToken = 0;
let lastSuggestionsKey = '';

function setupSettingsModal() {
    // Retry getting elements if not found initially
    settingsBtn = document.getElementById('settings-btn');
    settingsModal = document.getElementById('settings-modal-backdrop');
    settingsCloseBtn = document.getElementById('settings-modal-close');
    hearingSearchInput = document.getElementById('hearing-search-input');
    hearingSearchSuggestions = document.getElementById('hearing-search-suggestions');

    console.log('Settings elements:', { settingsBtn, settingsModal, settingsCloseBtn, hearingSearchInput, hearingSearchSuggestions });

    if (!settingsBtn) {
        console.error('Settings button not found in DOM');
        // Retry after a short delay
        setTimeout(() => {
            settingsBtn = document.getElementById('settings-btn');
            if (settingsBtn) {
                console.log('Settings button found on retry, setting up...');
                setupSettingsModal();
            } else {
                console.error('Settings button still not found after retry');
            }
        }, 100);
        return;
    }
    
    if (!settingsModal) {
        console.error('Settings modal backdrop not found in DOM');
        return;
    }

    // Remove any existing listeners by cloning and replacing
    const newBtn = settingsBtn.cloneNode(true);
    settingsBtn.parentNode?.replaceChild(newBtn, settingsBtn);
    settingsBtn = newBtn;

    // Use both capture and bubble phase to catch the event
    settingsBtn.addEventListener('click', function handleSettingsClick(e) {
        console.log('Settings button clicked - event caught', e);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Double-check modal exists
        let modal = document.getElementById('settings-modal-backdrop');
        if (!modal) {
            console.error('Settings modal not found when opening');
            return;
        }
        
        console.log('Opening modal, backdrop element:', modal);
        console.log('Modal classes before:', modal.className);
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        
        console.log('Modal classes after:', modal.className);
        console.log('Modal computed display:', window.getComputedStyle(modal).display);
        
        // Force reflow to ensure CSS is applied
        void modal.offsetHeight;
        
        // Verify modal is visible
        setTimeout(() => {
            const display = window.getComputedStyle(modal).display;
            console.log('Modal display after timeout:', display);
            if (display === 'none') {
                console.error('Modal still not visible! Forcing display...');
                modal.style.display = 'flex';
            }
        }, 10);
        
        // Clear search results when opening
        if (hearingSearchSuggestions) {
            hearingSearchSuggestions.style.display = 'none';
            hearingSearchSuggestions.innerHTML = '';
        }
        if (hearingSearchInput) {
            hearingSearchInput.value = '';
            hearingSearchInput.focus();
        }
    }, true); // Capture phase

    if (settingsCloseBtn && settingsModal) {
        settingsCloseBtn.addEventListener('click', () => {
            closeSettingsModal();
        });
    }

    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                closeSettingsModal();
            }
        });
    }

    // Setup search input handlers
    if (hearingSearchInput) {
        hearingSearchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const query = hearingSearchInput.value.trim();
            
            if (query.length < 2) {
                hideSuggestions();
                return;
            }
            
            searchTimeout = setTimeout(async () => {
                const token = ++currentSearchToken;
                try {
                    const latest = hearingSearchInput.value.trim();
                    if (latest !== query) return;
                    
                    const localResults = await searchLocally(query);
                    displaySuggestions(localResults || []);
                } catch (error) {
                    console.error('Search error:', error);
                }
            }, 100);
        });
        
        // Handle Enter key - if it's a number, fetch directly
        hearingSearchInput.addEventListener('keydown', async (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const query = hearingSearchInput.value.trim();
                if (!query) return;
                
                // If it's a number, fetch directly
                if (/^\d+$/.test(query)) {
                    hideSuggestions();
                    await handleFetchHearingById(query);
                    closeSettingsModal();
                    return;
                }
                
                // Otherwise, select first suggestion if available
                const firstItem = hearingSearchSuggestions?.querySelector('.suggestion-item');
                if (firstItem) {
                    const hearingId = Number(firstItem.dataset.hearingId);
                    if (hearingId) {
                        hideSuggestions();
                        hearingSearchInput.value = '';
                        await handleFetchHearingById(String(hearingId));
                        closeSettingsModal();
                    }
                }
            }
        });
    }
}

async function loadSearchIndex() {
    const noStoreOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } };
    try {
        const response = await fetch('/api/hearing-index?db=1', noStoreOpts);
        const data = await response.json().catch(() => ({}));
        if (data && data.success && Array.isArray(data.hearings)) {
            cachedSearchIndex = data.hearings;
            lastIndexFetch = Date.now();
            return data.hearings;
        }
    } catch (error) {
        console.error('Failed to load search index:', error);
    }
    cachedSearchIndex = [];
    lastIndexFetch = Date.now();
    return [];
}

async function searchLocally(query) {
    if (!cachedSearchIndex || INDEX_CACHE_TIME === 0 || Date.now() - lastIndexFetch > INDEX_CACHE_TIME) {
        await loadSearchIndex();
    }
    
    if (!cachedSearchIndex) return [];
    
    const q = query.toLowerCase();
    const isNumeric = /^\d+$/.test(query);
    
    return cachedSearchIndex
        .filter(h => {
            if (isNumeric) {
                return String(h.id).includes(query);
            }
            const title = (h.title || '').toLowerCase();
            return title.includes(q) || String(h.id).includes(query);
        })
        .slice(0, 20);
}

function sortSuggestionsForQuery(suggestions, query) {
    const isNumeric = /^\d+$/.test(query);
    if (!isNumeric) return suggestions;
    const exact = [], starts = [], contains = [], others = [];
    for (const item of suggestions) {
        const idStr = String(item.id || '');
        if (idStr === query) exact.push(item);
        else if (idStr.startsWith(query)) starts.push(item);
        else if (idStr.includes(query)) contains.push(item);
        else others.push(item);
    }
    return [].concat(exact, starts, contains, others);
}

function hideSuggestions() {
    if (!hearingSearchSuggestions) return;
    hearingSearchSuggestions.style.display = 'none';
    lastSuggestionsKey = '';
}

function closeSettingsModal() {
    if (settingsModal) {
        settingsModal.classList.remove('show');
        document.body.style.overflow = '';
    }
    hideSuggestions();
}

function displaySuggestions(suggestions) {
    if (!hearingSearchSuggestions || !hearingSearchInput) return;
    
    if (suggestions.length === 0) {
        hideSuggestions();
        return;
    }
    
    const currentQuery = hearingSearchInput.value.trim() || '';
    const sorted = sortSuggestionsForQuery(suggestions, currentQuery);
    
    // Dedupe UI updates
    const newKey = sorted.map(h => `${h.id}:${(h.title||'').trim()}`).join('|');
    if (newKey === lastSuggestionsKey) {
        return;
    }
    lastSuggestionsKey = newKey;
    
    hearingSearchSuggestions.innerHTML = sorted.map(h => {
        const safeTitle = (h.title && String(h.title).trim()) ? h.title : `Høring ${h.id}`;
        const deadline = formatDeadlineShort(h.deadline);
        const status = h.status || 'Ukendt';
        return `
            <div class="suggestion-item" data-hearing-id="${h.id}">
                <div class="suggestion-content">
                    <div class="suggestion-title">${safeTitle}</div>
                    <div class="suggestion-meta">
                        <span>ID: ${h.id}</span>
                        <span>•</span>
                        <span>Deadline: ${deadline}</span>
                        <span>•</span>
                        <span>Status: ${status}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    hearingSearchSuggestions.style.display = 'block';
    
    // Add click listeners
    hearingSearchSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', async () => {
            const hearingId = Number(item.dataset.hearingId);
            if (hearingId) {
                hideSuggestions();
                if (hearingSearchInput) hearingSearchInput.value = '';
                await handleFetchHearingById(String(hearingId));
                closeSettingsModal();
            }
        });
    });
}

async function loadHearings() {
    try {
        const data = await fetchJson('/api/gdpr/hearings');
        // Only show hearings that have been loaded via modal (have raw responses)
        state.hearings = (data.hearings || []).filter(hearing => {
            const rawCount = hearing.counts?.rawResponses ?? 0;
            return rawCount > 0;
        });
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
        approved: (detail.prepared?.responses || []).filter(r => r.approved).length || 0,
        published: detail.published?.responses?.length || 0
    };
    const materialsCount = {
        raw: detail.raw?.materials?.length || 0,
        prepared: detail.prepared?.materials?.length || 0,
        approved: (detail.prepared?.materials || []).filter(m => m.approved).length || 0,
        published: detail.published?.materials?.length || 0
    };
    return `
        <div class="detail-section" data-role="state">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-md);flex-wrap:wrap;">
                <div style="flex:1;">
                    <h2>${detail.hearing?.title || `Høring ${detail.hearing?.id}`}</h2>
                    <div style="margin-top:var(--space-sm);display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap;">
                        <span class="${status.className}">${status.text}</span>
                        <span class="status-pill ${responsesReady ? 'ready' : 'progress'}" title="Godkendte svar er klar til publicering. Rå svar er de originale fra blivhørt.">Svar godkendt: ${counts.approved}/${counts.raw}</span>
                        <span class="status-pill ${materialsReady ? 'ready' : 'progress'}">Materiale godkendt: ${materialsCount.approved}/${materialsCount.raw}</span>
                        <span class="status-pill ${counts.published > 0 ? 'ready' : 'progress'}" title="Publicerede svar og materiale er synlige på forsiden">Publicerede svar: ${counts.published}/${counts.raw}</span>
                        <span class="status-pill ${materialsCount.published > 0 ? 'ready' : 'progress'}" title="Publicerede materialer er synlige på forsiden">Publicerede materialer: ${materialsCount.published}/${materialsCount.raw}</span>
                        ${publishedAt ? `<span class="status-pill ready">Publiceret ${formatDateDisplay(publishedAt)}</span>` : ''}
                    </div>
                    <div style="margin-top:var(--space-sm);display:grid;gap:var(--space-xs);font-size:var(--font-size-sm);color:var(--color-gray-600);">
                        <span>Deadline: ${formatDeadline(detail.hearing?.deadline)}</span>
                        <span>Status: ${detail.hearing?.status || 'ukendt'}</span>
                    </div>
                </div>
                <div style="position:relative;">
                    <button class="btn btn-icon btn-secondary" id="hearing-actions-btn" title="Mere handlinger">
                        <svg class="icon" style="width:20px;height:20px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1"></circle>
                            <circle cx="12" cy="5" r="1"></circle>
                            <circle cx="12" cy="19" r="1"></circle>
                        </svg>
                    </button>
                    <div id="hearing-actions-menu" class="actions-menu" style="display:none;">
                        <button class="menu-item" data-action="refresh-raw">
                            <span>Opdater fra blivhørt</span>
                            <span class="menu-item-desc">Hent nye svar og bevar godkendte</span>
                        </button>
                        <button class="menu-item" data-action="reset-hearing">
                            <span>Fuld nulstil</span>
                            <span class="menu-item-desc">⚠️ Sletter alle klargjorte data</span>
                        </button>
                        <div class="menu-divider"></div>
                        <button class="menu-item menu-item-danger" data-action="delete-hearing">
                            <span>Slet høring</span>
                            <span class="menu-item-desc">Sletter alle data for denne høring</span>
                        </button>
                    </div>
                </div>
            </div>
            <div style="margin-top:var(--space-md);padding-top:var(--space-md);border-top:1px solid var(--color-gray-200);">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-sm);">
                    <div style="font-size:var(--font-size-sm);color:var(--color-gray-600);">
                        ${counts.approved + materialsCount.approved > 0 ? `${counts.approved + materialsCount.approved} godkendt${counts.approved + materialsCount.approved > 1 ? 'e' : ''} element${counts.approved + materialsCount.approved > 1 ? 'er' : ''} klar til publicering` : 'Ingen godkendte elementer at publicere'}
                    </div>
                    <button id="publish-btn-top" class="btn btn-primary" style="font-size:var(--font-size-base);padding:var(--space-sm) var(--space-lg);font-weight:600;">
                        Publicer alle godkendte
                    </button>
                </div>
            </div>
        </div>
    `;
}

function renderRawResponses(detail) {
    // Only show prepared responses - no raw responses display
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.dataset.section = 'prepared-responses-only';
    
    const preparedResponses = detail.prepared?.responses || [];
    const rawResponses = detail.raw?.responses || [];
    const approvedCount = preparedResponses.filter(r => r.approved).length;
    const totalCount = preparedResponses.length;
    
    // Check if filters are active
    const hasActiveFilters = state.filters.approved !== 'all' || 
                            state.filters.published !== 'all' ||
                            state.filters.hasAttachments !== 'all' || 
                            state.filters.organization.trim() !== '';
    
    wrapper.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-md);flex-wrap:wrap;">
            <div style="flex:1;min-width:200px;">
                <h2>Høringssvar</h2>
                <p style="margin-top:var(--space-xs);color:var(--color-gray-600);font-size:var(--font-size-sm);">
                    Redigér den klargjorte kopi og gem dine ændringer, eller nulstil til den oprindelige version. Svar markeres automatisk som klargjort når der gemmes.
                </p>
            </div>
            <div style="display:flex;flex-direction:column;gap:var(--space-xs);align-items:flex-end;">
                <button class="btn btn-icon btn-secondary" id="filter-btn" style="position:relative;" title="Filtrer svar">
                    <svg class="icon" style="width:20px;height:20px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"></path>
                    </svg>
                    ${hasActiveFilters ? '<span style="position:absolute;top:-4px;right:-4px;width:8px;height:8px;background:var(--color-primary);border-radius:50%;"></span>' : ''}
                </button>
                <div style="font-size:var(--font-size-xs);color:var(--color-gray-600);">
                    ${approvedCount} af ${totalCount} godkendt
                </div>
            </div>
        </div>
    `;
    
    const list = document.createElement('div');
    list.className = 'card-list';
    const usedPreparedIds = new Set();

    // If no prepared responses exist but raw responses do, show message
    if (!preparedResponses.length && rawResponses.length) {
        list.innerHTML = '<div class="list-empty">Ingen klargjorte svar endnu. Klik på "Hent rå data igen" for at oprette klargjorte svar fra de originale høringssvar.</div>';
    } else if (!preparedResponses.length && !rawResponses.length) {
        list.innerHTML = '<div class="list-empty">Ingen svar hentet fra blivhørt endnu.</div>';
    } else {
        // Get published response IDs for filtering
        const publishedResponseIds = new Set(
            (detail.published?.responses || []).map(r => Number(r.sourceResponseId || r.responseId)).filter(Number.isFinite)
        );
        
        // Apply filters
        const filteredResponses = applyFilters(preparedResponses, publishedResponseIds);
        
        // Create a map of preparedId to index in the full list for svarnummer
        const svarnummerMap = new Map();
        preparedResponses.forEach((r, index) => {
            svarnummerMap.set(Number(r.preparedId), index + 1);
        });
        
        if (filteredResponses.length === 0) {
            list.innerHTML = '<div class="list-empty">Ingen svar matcher de aktive filtre. Prøv at justere filterne.</div>';
        } else {
            // Show filtered prepared responses
            filteredResponses.forEach((prepared) => {
                const svarnummer = svarnummerMap.get(Number(prepared.preparedId)) || 1;
                const preparedCard = createPreparedResponseCard(prepared, svarnummer);
                list.appendChild(preparedCard);
                usedPreparedIds.add(Number(prepared.preparedId));
            });
        }
    }
    
    wrapper.appendChild(list);
    wrapper.usedPreparedIds = usedPreparedIds;
    
    // Add filter button click listener
    const filterBtn = wrapper.querySelector('#filter-btn');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            showFilterDialog(detail);
        });
    }
    
    return wrapper;
}

function applyFilters(responses, publishedResponseIds = new Set()) {
    let filtered = [...responses];
    
    // Filter by approved status
    if (state.filters.approved === 'approved') {
        filtered = filtered.filter(r => r.approved);
    } else if (state.filters.approved === 'not-approved') {
        filtered = filtered.filter(r => !r.approved);
    }
    
    // Filter by published status
    if (state.filters.published === 'published') {
        filtered = filtered.filter(r => {
            // Check if this response has been published (by matching source_response_id)
            const sourceId = r.sourceResponseId;
            return sourceId !== null && sourceId !== undefined && publishedResponseIds.has(Number(sourceId));
        });
    } else if (state.filters.published === 'not-published') {
        filtered = filtered.filter(r => {
            const sourceId = r.sourceResponseId;
            return sourceId === null || sourceId === undefined || !publishedResponseIds.has(Number(sourceId));
        });
    }
    
    // Filter by attachments
    if (state.filters.hasAttachments === 'yes') {
        filtered = filtered.filter(r => r.hasAttachments);
    } else if (state.filters.hasAttachments === 'no') {
        filtered = filtered.filter(r => !r.hasAttachments);
    }
    
    // Filter by organization
    if (state.filters.organization.trim() !== '') {
        const orgFilter = state.filters.organization.trim().toLowerCase();
        filtered = filtered.filter(r => {
            const org = (r.organization || '').toLowerCase();
            const respondent = (r.respondentName || '').toLowerCase();
            return org.includes(orgFilter) || respondent.includes(orgFilter);
        });
    }
    
    return filtered;
}

function showFilterDialog(detail) {
    const preparedResponses = detail.prepared?.responses || [];
    const organizations = [...new Set(preparedResponses.map(r => r.organization).filter(Boolean))].sort();
    
    // Create or get modal backdrop
    let backdrop = document.getElementById('filter-modal-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'filter-modal-backdrop';
        backdrop.className = 'filter-modal-backdrop';
        backdrop.innerHTML = `
            <div class="filter-modal">
                <div class="filter-modal-header">
                    <h3>Filtrer svar</h3>
                    <button class="btn btn-icon btn-ghost" id="filter-modal-close">
                        <svg class="icon" style="width:20px;height:20px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                <div class="filter-modal-body">
                    <div class="filter-group">
                        <label class="filter-label">Godkendelsesstatus</label>
                        <div class="filter-options">
                            <label class="filter-option">
                                <input type="radio" name="filter-approved" value="all">
                                <span>Alle</span>
                            </label>
                            <label class="filter-option">
                                <input type="radio" name="filter-approved" value="approved">
                                <span>Kun godkendte</span>
                            </label>
                            <label class="filter-option">
                                <input type="radio" name="filter-approved" value="not-approved">
                                <span>Kun ikke-godkendte</span>
                            </label>
                        </div>
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Publiceringsstatus</label>
                        <div class="filter-options">
                            <label class="filter-option">
                                <input type="radio" name="filter-published" value="all">
                                <span>Alle</span>
                            </label>
                            <label class="filter-option">
                                <input type="radio" name="filter-published" value="published">
                                <span>Kun publicerede</span>
                            </label>
                            <label class="filter-option">
                                <input type="radio" name="filter-published" value="not-published">
                                <span>Kun ikke-publicerede</span>
                            </label>
                        </div>
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Vedhæftninger</label>
                        <div class="filter-options">
                            <label class="filter-option">
                                <input type="radio" name="filter-attachments" value="all">
                                <span>Alle</span>
                            </label>
                            <label class="filter-option">
                                <input type="radio" name="filter-attachments" value="yes">
                                <span>Kun med vedhæftninger</span>
                            </label>
                            <label class="filter-option">
                                <input type="radio" name="filter-attachments" value="no">
                                <span>Kun uden vedhæftninger</span>
                            </label>
                        </div>
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Organisation/navn</label>
                        <input type="text" id="filter-organization" class="filter-input" placeholder="Søg efter organisation eller navn..." value="${state.filters.organization || ''}">
                    </div>
                </div>
                <div class="filter-modal-footer">
                    <button class="btn btn-secondary" id="filter-reset">Nulstil filtre</button>
                    <button class="btn btn-primary" id="filter-apply">Anvend filtre</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        
        // Add event listeners
        backdrop.querySelector('#filter-modal-close').addEventListener('click', () => {
            backdrop.classList.remove('show');
        });
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                backdrop.classList.remove('show');
            }
        });
        backdrop.querySelector('#filter-reset').addEventListener('click', () => {
            state.filters = { approved: 'all', published: 'all', hasAttachments: 'all', organization: '' };
            updateFilterDialog();
            renderHearingDetail();
            backdrop.classList.remove('show');
        });
        backdrop.querySelector('#filter-apply').addEventListener('click', () => {
            // Read values from dialog
            const approvedRadio = backdrop.querySelector('input[name="filter-approved"]:checked');
            const publishedRadio = backdrop.querySelector('input[name="filter-published"]:checked');
            const attachmentsRadio = backdrop.querySelector('input[name="filter-attachments"]:checked');
            const orgInput = backdrop.querySelector('#filter-organization');
            
            state.filters.approved = approvedRadio?.value || 'all';
            state.filters.published = publishedRadio?.value || 'all';
            state.filters.hasAttachments = attachmentsRadio?.value || 'all';
            state.filters.organization = orgInput?.value || '';
            
            renderHearingDetail();
            backdrop.classList.remove('show');
        });
    }
    
    updateFilterDialog();
    backdrop.classList.add('show');
}

function updateFilterDialog() {
    const backdrop = document.getElementById('filter-modal-backdrop');
    if (!backdrop) return;
    
    const approvedRadio = backdrop.querySelector(`input[name="filter-approved"][value="${state.filters.approved}"]`);
    if (approvedRadio) approvedRadio.checked = true;
    
    const publishedRadio = backdrop.querySelector(`input[name="filter-published"][value="${state.filters.published || 'all'}"]`);
    if (publishedRadio) publishedRadio.checked = true;
    
    const attachmentsRadio = backdrop.querySelector(`input[name="filter-attachments"][value="${state.filters.hasAttachments}"]`);
    if (attachmentsRadio) attachmentsRadio.checked = true;
    
    const orgInput = backdrop.querySelector('#filter-organization');
    if (orgInput) orgInput.value = state.filters.organization || '';
}

function createBadge(text) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = text;
    return span;
}

function createPreparedResponseCard(prepared, svarnummer) {
    const card = createCardFromTemplate('preparedResponse');
    card.dataset.preparedId = prepared.preparedId;
    const title = card.querySelector('.title-group');
    const respondentName = prepared.respondentName || 'Borger';
    const respondentType = prepared.respondentType || 'Borger';
    title.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:var(--space-sm);flex:1;">
            <strong>Svarnummer ${svarnummer}</strong>
            <div style="display:flex;gap:var(--space-sm);flex-wrap:wrap;align-items:center;">
                <div style="display:flex;gap:var(--space-xs);align-items:center;flex:1;min-width:200px;">
                    <label style="font-size:var(--font-size-sm);color:var(--color-gray-600);white-space:nowrap;">Navn:</label>
                    <input type="text" 
                           class="respondent-name-input" 
                           data-prepared-id="${prepared.preparedId}"
                           value="${respondentName.replace(/"/g, '&quot;')}" 
                           style="flex:1;padding:var(--space-xs) var(--space-sm);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);"
                           placeholder="Borger">
                </div>
                <div style="display:flex;gap:var(--space-xs);align-items:center;flex:1;min-width:200px;">
                    <label style="font-size:var(--font-size-sm);color:var(--color-gray-600);white-space:nowrap;">Type:</label>
                    <select class="respondent-type-select" 
                            data-prepared-id="${prepared.preparedId}"
                            style="flex:1;padding:var(--space-xs) var(--space-sm);border:1px solid var(--color-gray-300);border-radius:var(--radius-sm);font-size:var(--font-size-sm);">
                        ${RESPONDENT_TYPES.map(type => 
                            `<option value="${type}" ${type === respondentType ? 'selected' : ''}>${type}</option>`
                        ).join('')}
                    </select>
                </div>
            </div>
            <div class="pill-group">
                ${prepared.organization ? `<span class="badge">${prepared.organization}</span>` : ''}
                ${prepared.hasAttachments ? '<span class="badge">Vedhæftninger</span>' : ''}
            </div>
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

    responses.forEach((resp) => {
        const card = createPreparedResponseCard(resp);
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
            <label for="material-upload" class="btn btn-secondary" style="cursor:pointer;display:inline-flex;align-items:center;gap:var(--space-sm);">
                <svg class="icon" style="width:18px;height:18px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                Vælg fil
            </label>
            <input type="file" id="material-upload" accept=".pdf,.md,.markdown,.txt" style="display:none;">
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

function renderFooter(detail) {
    const counts = {
        raw: detail.raw?.responses?.length || 0,
        approved: (detail.prepared?.responses || []).filter(r => r.approved).length || 0,
        published: detail.published?.responses?.length || 0
    };
    const materialsCount = {
        raw: detail.raw?.materials?.length || 0,
        approved: (detail.prepared?.materials || []).filter(m => m.approved).length || 0,
        published: detail.published?.materials?.length || 0
    };
    const totalApproved = counts.approved + materialsCount.approved;
    
    return `
        <div class="publish-footer">
            <div class="publish-footer-content">
                <div class="publish-footer-info">
                    <div class="publish-footer-text">
                        ${totalApproved > 0 ? `${totalApproved} godkendt${totalApproved > 1 ? 'e' : ''} element${totalApproved > 1 ? 'er' : ''} klar til publicering` : 'Ingen godkendte elementer at publicere'}
                    </div>
                    <div class="publish-footer-hint">
                        Kun godkendte svar og materiale vil blive publiceret
                    </div>
                </div>
                <button id="publish-btn" class="btn btn-primary publish-footer-btn" ${totalApproved === 0 ? 'disabled' : ''}>
                    Publicer alle godkendte
                </button>
            </div>
        </div>
    `;
}

function renderHearingDetail() {
    if (!state.detail) return;
    const detail = state.detail;
    const doc = document.createDocumentFragment();
    const container = document.createElement('div');
    container.innerHTML = renderStateSection(detail);
    doc.appendChild(container.firstElementChild);
    // Only show prepared responses - no raw responses section
    const responsesSection = renderRawResponses(detail);
    doc.appendChild(responsesSection);
    doc.appendChild(renderMaterials(detail));
    // Add footer with publish button
    const footerContainer = document.createElement('div');
    footerContainer.innerHTML = renderFooter(detail);
    doc.appendChild(footerContainer.firstElementChild);
    detailEl.innerHTML = '';
    detailEl.appendChild(doc);
    
    // Add event listeners for both publish buttons
    const publishBtnTop = detailEl.querySelector('#publish-btn-top');
    const publishBtn = detailEl.querySelector('#publish-btn');
    if (publishBtnTop) {
        publishBtnTop.addEventListener('click', handlePublish);
    }
    if (publishBtn) {
        publishBtn.addEventListener('click', handlePublish);
    }
    
    // Actions menu toggle
    const actionsBtn = detailEl.querySelector('#hearing-actions-btn');
    const actionsMenu = detailEl.querySelector('#hearing-actions-menu');
    if (actionsBtn && actionsMenu) {
        actionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = actionsMenu.style.display !== 'none';
            actionsMenu.style.display = isVisible ? 'none' : 'block';
        });
        
        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!actionsMenu.contains(e.target) && e.target !== actionsBtn) {
                actionsMenu.style.display = 'none';
            }
        });
        
        // Handle menu item clicks
        actionsMenu.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', async () => {
                actionsMenu.style.display = 'none';
                const action = item.dataset.action;
                if (action === 'refresh-raw') {
                    await handleRefreshRaw();
                } else if (action === 'reset-hearing') {
                    await handleResetHearing();
                } else if (action === 'delete-hearing') {
                    await handleDeleteHearing();
                }
            });
        });
    }
}

async function handleSavePrepared(preparedId) {
    if (!state.detail || !state.currentId) return;
    const card = detailEl.querySelector(`.prepared-response[data-prepared-id="${preparedId}"]`);
    if (!card) return;
    const textArea = card.querySelector('textarea[data-role="text"]');
    const approvedCheckbox = card.querySelector('[data-role="approved"]');
    const respondentNameInput = card.querySelector(`.respondent-name-input[data-prepared-id="${preparedId}"]`);
    const respondentTypeSelect = card.querySelector(`.respondent-type-select[data-prepared-id="${preparedId}"]`);
    const prepared = (state.detail.prepared?.responses || []).find(r => Number(r.preparedId) === Number(preparedId));
    if (!prepared) return;
    try {
        // Auto-markér som klargjort når der gemmes
        const now = Date.now();
        const respondentName = respondentNameInput?.value?.trim() || 'Borger';
        const respondentType = respondentTypeSelect?.value || 'Borger';
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                preparedId,
                sourceResponseId: prepared.sourceResponseId ?? null,
                respondentName: respondentName || 'Borger',
                respondentType: RESPONDENT_TYPES.includes(respondentType) ? respondentType : 'Borger',
                author: prepared.author ?? null,
                organization: prepared.organization ?? null,
                onBehalfOf: prepared.onBehalfOf ?? null,
                submittedAt: prepared.submittedAt ?? null,
                textMd: textArea.value,
                hasAttachments: prepared.hasAttachments,
                attachmentsReady: prepared.attachmentsReady,
                approved: true, // Auto-markér som klargjort når der gemmes
                approvedAt: now,
                notes: prepared.notes ?? null
            })
        });
        // Opdater checkbox til at reflektere auto-markering
        approvedCheckbox.checked = true;
        await loadHearingDetail(state.currentId);
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
        // Auto-markér som klargjort når der gemmes
        const now = Date.now();
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/attachments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                attachmentId,
                convertedMd: textArea.value,
                approved: true, // Auto-markér som klargjort når der gemmes
                approvedAt: now,
                conversionStatus: 'manual-edit'
            })
        });
        // Opdater checkbox til at reflektere auto-markering
        approvedCheckbox.checked = true;
        await loadHearingDetail(state.currentId);
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
        // Auto-markér som klargjort når der gemmes
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
                approved: true, // Auto-markér som klargjort når der gemmes
                approvedAt: now
            })
        });
        // Opdater checkbox til at reflektere auto-markering
        approvedCheckbox.checked = true;
        await loadHearingDetail(state.currentId);
    } catch (error) {
        showError(`Fejl ved gem af materiale: ${error.message}`);
    }
}

async function handleDeleteMaterial(materialId) {
    if (!confirm('Slet dette materiale?')) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/materials/${materialId}`, { method: 'DELETE' });
        await loadHearingDetail(state.currentId);
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

async function handleResetPrepared(preparedId) {
    if (!state.currentId || !preparedId) return;
    const confirmReset = confirm('Nulstil dette høringssvar til den originale tekst fra blivhørt?');
    if (!confirmReset) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/responses/${preparedId}/reset`, { method: 'POST' });
        await loadHearingDetail(state.currentId);
    } catch (error) {
        showError(`Kunne ikke nulstille svaret: ${error.message}`);
    }
}

async function handleRefreshRaw() {
    if (!state.currentId) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/refresh-raw`, { method: 'POST' });
        await Promise.all([loadHearings(), loadHearingDetail(state.currentId)]);
        showSuccess('Høringssvar er opdateret fra blivhørt. Nye svar er tilføjet, eksisterende godkendte svar er bevaret, og AI-kontekst er opdateret.');
    } catch (error) {
        showError(`Kunne ikke opdatere fra blivhørt: ${error.message}`);
    }
}

async function handleDeleteHearing() {
    if (!state.currentId) return;
    const confirmDelete = confirm(`Er du sikker på at du vil slette høring ${state.currentId}? Dette sletter alle data relateret til denne høring (rå svar, klargjorte svar, publicerede svar og materiale).`);
    if (!confirmDelete) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}`, { method: 'DELETE' });
        state.currentId = null;
        await Promise.all([loadHearings(), loadHearingDetail(null)]);
        showSuccess('Høringen er blevet slettet.');
    } catch (error) {
        showError(`Kunne ikke slette høringen: ${error.message}`);
    }
}

async function handleFetchHearingById(hearingIdParam) {
    const hearingId = hearingIdParam || hearingSearchInput?.value?.trim();
    if (!hearingId || !/^\d+$/.test(hearingId)) {
        showError('Indtast et gyldigt hørings-ID');
        return;
    }
    const id = Number(hearingId);
    
    // Check if hearing already exists in the list
    const existingHearing = state.hearings.find(h => Number(h.hearingId) === id);
    if (existingHearing) {
        await selectHearing(id);
        if (hearingSearchInput) hearingSearchInput.value = '';
        hideSuggestions();
        return;
    }
    
    // Add loading item to the hearing list
    let loadingItem = null;
    if (hearingListEl) {
        loadingItem = document.createElement('div');
        loadingItem.className = 'hearing-item';
        loadingItem.dataset.hearingId = id;
        loadingItem.dataset.loading = 'true';
        loadingItem.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:4px;">
                <strong>Høring ${id}</strong>
                <div style="display:flex;align-items:center;gap:var(--space-sm);font-size:var(--font-size-sm);color:var(--color-gray-600);">
                    <div class="loading-spinner"></div>
                    <span>Henter høringssvar...</span>
                </div>
            </div>
        `;
        // Insert at the beginning of the list
        if (hearingListEl.firstChild) {
            hearingListEl.insertBefore(loadingItem, hearingListEl.firstChild);
        } else {
            hearingListEl.appendChild(loadingItem);
        }
    }
    
    if (hearingSearchInput) {
        hearingSearchInput.disabled = true;
    }
    
    try {
        // Fetch and hydrate hearing data
        await fetchJson(`/api/gdpr/hearing/${id}/refresh-raw`, { method: 'POST' });
        // Reload hearings list and select the hearing
        await loadHearings();
        await selectHearing(id);
        if (hearingSearchInput) hearingSearchInput.value = '';
        hideSuggestions();
        
        if (settingsModal) {
            closeSettingsModal();
            setTimeout(() => {
                showSuccess('Høringssvar er hentet og høringen er tilføjet til listen.');
            }, 300);
        } else {
            showSuccess('Høringssvar er hentet og høringen er tilføjet til listen.');
        }
    } catch (error) {
        // Remove loading item on error
        if (loadingItem && loadingItem.parentElement) {
            loadingItem.remove();
        }
        showError(`Kunne ikke hente høringssvar: ${error.message}`);
    } finally {
        if (hearingSearchInput) {
            hearingSearchInput.disabled = false;
        }
    }
}

async function handleCleanupDuplicates() {
    if (!state.currentId) return;
    const confirmCleanup = confirm('Dette fjerner duplikerede klargjorte svar og bevarer kun én kopi per originalt svar. Vil du fortsætte?');
    if (!confirmCleanup) return;
    try {
        const result = await fetchJson(`/api/gdpr/hearing/${state.currentId}/cleanup-duplicates`, { method: 'POST' });
        await Promise.all([loadHearings(), loadHearingDetail(state.currentId)]);
        showSuccess(`Duplikater er blevet ryddet op. ${result.deletedCount || 0} ekstra svar blev slettet.`);
    } catch (error) {
        showError(`Kunne ikke rydde duplikater: ${error.message}`);
    }
}

async function handleClearPublished() {
    if (!state.currentId) return;
    const confirmClear = confirm('Dette sletter alle publicerede svar og materiale. Vil du fortsætte?');
    if (!confirmClear) return;
    try {
        await fetchJson(`/api/gdpr/hearing/${state.currentId}/published`, { method: 'DELETE' });
        await Promise.all([loadHearings(), loadHearingDetail(state.currentId)]);
        showSuccess('Publicerede svar og materiale er blevet slettet.');
    } catch (error) {
        showError(`Kunne ikke slette publicerede data: ${error.message}`);
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

// All event listeners must be set up after DOM is ready
function setupEventListeners() {
    if (!detailEl) {
        console.error('detailEl ikke fundet ved setupEventListeners');
        return;
    }
    
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
        if (action === 'reset-hearing') {
            await handleResetHearing();
        }
        if (action === 'refresh-raw') {
            await handleRefreshRaw();
        }
        if (action === 'clear-published') {
            await handleClearPublished();
        }
        if (action === 'delete-hearing') {
            await handleDeleteHearing();
        }
        if (action === 'cleanup-duplicates') {
            await handleCleanupDuplicates();
        }
        if (button.id === 'publish-btn' || button.id === 'publish-btn-top') {
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
}

if (hearingListEl) {
    hearingListEl.addEventListener('click', (event) => {
        const item = event.target.closest('.hearing-item');
        if (!item) return;
        // Don't allow clicking on loading items
        if (item.dataset.loading === 'true') return;
        const id = Number(item.dataset.hearingId);
        if (id) selectHearing(id);
    });
} else {
    console.warn('hearingListEl ikke fundet');
}

async function init() {
    if (!hearingListEl) {
        console.error('hearingListEl ikke fundet');
        return;
    }
    // Don't auto-load hearings - user must use settings modal to search and fetch
    hearingListEl.innerHTML = '<div class="list-empty">Brug indstillinger (⚙️) for at søge og hente høringer</div>';
}

// Setup settings modal after DOM is ready
function initializePage() {
    try {
        console.log('Initialiserer side...');
        console.log('DOM elementer:', {
            settingsBtn: document.getElementById('settings-btn'),
            settingsModal: document.getElementById('settings-modal-backdrop'),
            hearingListEl: document.getElementById('hearing-list')
        });
        setupSettingsModal();
        setupEventListeners();
        init().catch(error => {
            console.error('Initialisering fejlede', error);
        });
    } catch (error) {
        console.error('Fejl ved initialisering af side:', error);
    }
}

// Wait for DOM to be fully ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePage);
} else {
    // DOM is already ready
    initializePage();
}

