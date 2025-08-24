/**
 * Local Data Cache Manager
 * Handles persistent storage of hearing data using IndexedDB with localStorage fallback
 */

class DataCache {
    constructor() {
        this.dbName = 'BlivhoertCache';
        // Bump version to ensure onupgradeneeded runs and creates any missing stores
        this.dbVersion = 3;
        this.db = null;
        this.useIndexedDB = true;
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours default
        this.searchIndexExpiry = 2 * 60 * 60 * 1000; // 2 hours for search index
    }

    async init() {
        try {
            if ('indexedDB' in window) {
                await this._initIndexedDB();
            } else {
                console.log('IndexedDB not supported, falling back to localStorage');
                this.useIndexedDB = false;
            }
        } catch (error) {
            console.warn('Failed to initialize IndexedDB, falling back to localStorage', error);
            this.useIndexedDB = false;
        }
    }

    async _initIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Store for search index
                if (!db.objectStoreNames.contains('searchIndex')) {
                    db.createObjectStore('searchIndex', { keyPath: 'id' });
                }
                
                // Store for hearing details
                if (!db.objectStoreNames.contains('hearings')) {
                    db.createObjectStore('hearings', { keyPath: 'id' });
                }
                
                // Store for hearing responses
                if (!db.objectStoreNames.contains('responses')) {
                    db.createObjectStore('responses', { keyPath: 'hearingId' });
                }
                
                // Store for hearing materials
                if (!db.objectStoreNames.contains('materials')) {
                    db.createObjectStore('materials', { keyPath: 'hearingId' });
                }
            };
        });
    }

    async _getFromIndexedDB(storeName, key) {
        if (!this.db) return null;
        // Gracefully handle missing object stores
        try {
            if (!this.db.objectStoreNames || !this.db.objectStoreNames.contains(storeName)) {
                return null;
            }
        } catch (_) {
            return null;
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            
            request.onsuccess = () => {
                const data = request.result;
                if (data && this._isExpired(data.timestamp, storeName)) {
                    this._deleteFromIndexedDB(storeName, key);
                    resolve(null);
                } else {
                    resolve(data);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async _setToIndexedDB(storeName, data) {
        if (!this.db) return;
        try {
            if (!this.db.objectStoreNames || !this.db.objectStoreNames.contains(storeName)) {
                return;
            }
        } catch (_) {
            return;
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            data.timestamp = Date.now();
            const request = store.put(data);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async _deleteFromIndexedDB(storeName, key) {
        if (!this.db) return;
        try {
            if (!this.db.objectStoreNames || !this.db.objectStoreNames.contains(storeName)) {
                return;
            }
        } catch (_) {
            return;
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    _getFromLocalStorage(key) {
        try {
            const data = localStorage.getItem(key);
            if (!data) return null;
            
            const parsed = JSON.parse(data);
            if (this._isExpired(parsed.timestamp, key)) {
                localStorage.removeItem(key);
                return null;
            }
            
            return parsed;
        } catch (error) {
            console.warn('Failed to get from localStorage', error);
            return null;
        }
    }

    _setToLocalStorage(key, data) {
        try {
            data.timestamp = Date.now();
            localStorage.setItem(key, JSON.stringify(data));
        } catch (error) {
            console.warn('Failed to set to localStorage', error);
            // Clean up old data if storage is full
            this._cleanupLocalStorage();
        }
    }

    _cleanupLocalStorage() {
        const keys = Object.keys(localStorage);
        const cacheKeys = keys.filter(k => k.startsWith('blivhoert_'));
        
        // Sort by timestamp and remove oldest
        const items = cacheKeys.map(key => {
            try {
                const data = JSON.parse(localStorage.getItem(key));
                return { key, timestamp: data.timestamp || 0 };
            } catch {
                return { key, timestamp: 0 };
            }
        });
        
        items.sort((a, b) => a.timestamp - b.timestamp);
        
        // Remove oldest 25%
        const toRemove = Math.ceil(items.length * 0.25);
        for (let i = 0; i < toRemove; i++) {
            localStorage.removeItem(items[i].key);
        }
    }

    _isExpired(timestamp, type) {
        if (!timestamp) return true;
        
        const age = Date.now() - timestamp;
        const expiry = type.includes('searchIndex') ? this.searchIndexExpiry : this.cacheExpiry;
        
        return age > expiry;
    }

    // Public API methods

    async getSearchIndex() {
        if (this.useIndexedDB) {
            const data = await this._getFromIndexedDB('searchIndex', 'all');
            if (data && Array.isArray(data.items)) return data.items;
            // Fallback: if IndexedDB entry is missing (e.g., store cleared), try localStorage backup
            const backup = this._getFromLocalStorage('blivhoert_searchIndex');
            return backup ? backup.items : null;
        } else {
            const data = this._getFromLocalStorage('blivhoert_searchIndex');
            return data ? data.items : null;
        }
    }

    async setSearchIndex(items) {
        const data = { id: 'all', items };
        
        if (this.useIndexedDB) {
            await this._setToIndexedDB('searchIndex', data);
            // Redundant backup for robustness: also store a copy in localStorage
            try { this._setToLocalStorage('blivhoert_searchIndex', data); } catch (_) {}
        } else {
            this._setToLocalStorage('blivhoert_searchIndex', data);
        }
    }

    async getHearing(hearingId) {
        if (this.useIndexedDB) {
            return await this._getFromIndexedDB('hearings', hearingId);
        } else {
            return this._getFromLocalStorage(`blivhoert_hearing_${hearingId}`);
        }
    }

    async setHearing(hearingId, data) {
        const cacheData = { id: hearingId, ...data };
        
        if (this.useIndexedDB) {
            await this._setToIndexedDB('hearings', cacheData);
        } else {
            this._setToLocalStorage(`blivhoert_hearing_${hearingId}`, cacheData);
        }
    }

    async getResponses(hearingId) {
        if (this.useIndexedDB) {
            const data = await this._getFromIndexedDB('responses', hearingId);
            return data ? data.responses : null;
        } else {
            const data = this._getFromLocalStorage(`blivhoert_responses_${hearingId}`);
            return data ? data.responses : null;
        }
    }

    async setResponses(hearingId, responses) {
        const data = { hearingId, responses };
        
        if (this.useIndexedDB) {
            await this._setToIndexedDB('responses', data);
        } else {
            this._setToLocalStorage(`blivhoert_responses_${hearingId}`, data);
        }
    }

    async getMaterials(hearingId) {
        if (this.useIndexedDB) {
            const data = await this._getFromIndexedDB('materials', hearingId);
            return data ? data.materials : null;
        } else {
            const data = this._getFromLocalStorage(`blivhoert_materials_${hearingId}`);
            return data ? data.materials : null;
        }
    }

    async setMaterials(hearingId, materials) {
        const data = { hearingId, materials };
        
        if (this.useIndexedDB) {
            await this._setToIndexedDB('materials', data);
        } else {
            this._setToLocalStorage(`blivhoert_materials_${hearingId}`, data);
        }
    }

    async clearCache() {
        if (this.useIndexedDB && this.db) {
            const stores = ['searchIndex', 'hearings', 'responses', 'materials'];
            
            for (const storeName of stores) {
                try {
                    if (!this.db.objectStoreNames || !this.db.objectStoreNames.contains(storeName)) {
                        continue;
                    }
                } catch (_) {
                    continue;
                }
                await new Promise((resolve, reject) => {
                    const transaction = this.db.transaction([storeName], 'readwrite');
                    const store = transaction.objectStore(storeName);
                    const request = store.clear();
                    
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
            }
        } else {
            const keys = Object.keys(localStorage);
            keys.filter(k => k.startsWith('blivhoert_')).forEach(k => localStorage.removeItem(k));
        }
    }

    // Preload methods for background fetching
    async preloadHearing(hearingId) {
        // Check if already cached
        const cached = await this.getHearing(hearingId);
        if (cached && !this._isExpired(cached.timestamp, 'hearing')) {
            return;
        }

        try {
            // Try persisted-only snapshot to avoid triggering heavy fetches during preload
            const respPersist = await fetch(`/api/hearing/${hearingId}?persistOnly=1`);
            const data = await respPersist.json();
            
            if (data && data.success && (data.found || data.hearing)) {
                await this.setHearing(hearingId, data);
                
                // Also cache responses if included
                if (data.responses) {
                    await this.setResponses(hearingId, data.responses);
                }
            } else {
                // Queue a background warm on the server so snapshot becomes available soon
                try { fetch(`/api/warm/${encodeURIComponent(hearingId)}`, { method: 'POST' }).catch(()=>{}); } catch {}
            }
        } catch (error) {
            console.warn(`Failed to preload hearing ${hearingId}`, error);
        }
    }

    async preloadMaterials(hearingId) {
        // Check if already cached
        const cached = await this.getMaterials(hearingId);
        if (cached && !this._isExpired(cached.timestamp, 'materials')) {
            return;
        }

        try {
            const respPersist = await fetch(`/api/hearing/${hearingId}/materials?persistOnly=1`);
            const data = await respPersist.json();
            
            if (data && data.success && Array.isArray(data.materials) && data.materials.length) {
                await this.setMaterials(hearingId, data.materials);
            } else {
                try { fetch(`/api/warm/${encodeURIComponent(hearingId)}`, { method: 'POST' }).catch(()=>{}); } catch {}
            }
        } catch (error) {
            console.warn(`Failed to preload materials for hearing ${hearingId}`, error);
        }
    }
}

// Create global instance
window.dataCache = new DataCache();

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
    await window.dataCache.init();
});
