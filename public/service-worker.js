const CACHE_NAME = 'blivhoert-v5';
const API_CACHE_NAME = 'blivhoert-api-v5';

// Cache static assets
const urlsToCache = [
    '/',
    '/index.html',
    '/work.html',
    '/global-styles.css',
    '/js/data-cache.js',
    '/favicon.svg',
    '/icons.svg'
];

// Install Service Worker
self.addEventListener('install', event => {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then(cache => {
				console.log('Opened cache');
				return cache.addAll(urlsToCache);
			})
			.then(() => self.skipWaiting())
	);
});

// Clean up old caches
self.addEventListener('activate', event => {
	event.waitUntil(
		Promise.all([
			caches.keys().then(cacheNames => {
				return Promise.all(
					cacheNames.map(cacheName => {
						if (cacheName !== CACHE_NAME && cacheName !== API_CACHE_NAME) {
							return caches.delete(cacheName);
						}
					})
				);
			}),
			self.clients.claim()
		])
	);
});

// Fetch event
self.addEventListener('fetch', event => {
	const { request } = event;
	const url = new URL(request.url);

	// DO NOT intercept Server-Sent Events or summarize endpoints at all (bypass SW)
	const isSse = (request.headers.get('accept') || '').includes('text/event-stream');
	if (isSse || url.pathname.startsWith('/api/summarize/')) {
		// Let the browser fetch directly; no respondWith so it bypasses the SW entirely
		return;
	}

	// Network-first for HTML/documents to avoid stale pages
	const isDocumentRequest = request.mode === 'navigate' || request.destination === 'document' || ((request.headers.get('accept') || '').includes('text/html'));
	if (!url.pathname.startsWith('/api/') && isDocumentRequest) {
		event.respondWith(
			fetch(request)
				.then(networkResponse => {
					return caches.open(CACHE_NAME).then(cache => {
						if (networkResponse && networkResponse.status === 200) {
							cache.put(request, networkResponse.clone());
						}
						return networkResponse;
					});
				})
				.catch(() => caches.match(request).then(r => r || caches.match('/index.html')))
		);
		return;
	}

	// Handle API requests (network-first, cache on success, robust fallback)
	if (url.pathname.startsWith('/api/')) {
		// Skip caching for POST requests
		if (request.method === 'POST') {
			event.respondWith(fetch(request));
			return;
		}

		// Network-first with structured fallback when both network and cache miss
		event.respondWith((async () => {
			const cache = await caches.open(API_CACHE_NAME);
			try {
				const response = await fetch(request);
				// Avoid caching explicit nocache requests
				if (response && response.status === 200 && url.searchParams.get('nocache') !== '1') {
					cache.put(request, response.clone());
				}
				return response;
			} catch (err) {
				const cached = await cache.match(request);
				if (cached) return cached;
				const wantsJson = (request.headers.get('accept') || '').includes('application/json');
				const body = wantsJson ? JSON.stringify({ success: false, message: 'Netværk fejlede eller timeout', error: (err && err.name) || 'FetchError' }) : 'Gateway Timeout';
				return new Response(body, { status: 504, headers: { 'Content-Type': wantsJson ? 'application/json' : 'text/plain' } });
			}
		})());
		return;
	}

	// Static assets: cache-first, then network
	event.respondWith(
		caches.match(request)
			.then(response => {
				return response || fetch(request).then(fetchResponse => {
					return caches.open(CACHE_NAME).then(cache => {
						if (fetchResponse.status === 200) {
							cache.put(request, fetchResponse.clone());
						}
						return fetchResponse;
					});
				});
			})
			.catch(() => {
				if (request.destination === 'document') {
					return caches.match('/index.html');
				}
			})
	);
});
