const CACHE_NAME = 'razkindo-erp-v4';
const STATIC_ASSETS = [
  '/',
  '/logo.svg',
];

// Install: cache static assets only (NOT API routes)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches only (keep current cache)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// ================================
// PUSH NOTIFICATION HANDLER
// ================================

self.addEventListener('push', (event) => {
  let data = {
    title: 'Razkindo ERP',
    body: 'Anda memiliki notifikasi baru',
    icon: '/logo.svg',
    badge: '/logo.svg',
    tag: 'default',
    data: { url: '/' },
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch {
      // If not JSON, use as text body
      data.body = event.data.text() || data.body;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/logo.svg',
    badge: data.badge || '/logo.svg',
    tag: data.tag || 'default',
    data: data.data || { url: '/' },
    requireInteraction: data.requireInteraction || false,
    vibrate: data.requireInteraction ? [200, 100, 200, 100, 200] : [100],
    actions: data.actions || [],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Handle notification click - focus or open the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Check if there's already a window open
        for (const client of clientList) {
          // Focus the first window that matches
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        // No window open — open a new one
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

// Handle notification close (for analytics/acknowledgement)
self.addEventListener('notificationclose', (event) => {
  // Could track that user dismissed the notification
  // For now, no action needed
});

// Handle push subscription change (deprecated event, polyfill with periodic check)
// Modern browsers handle subscription renewal automatically
self.addEventListener('pushsubscriptionchange', (event) => {
  console.log('[SW] Push subscription changed, re-subscribing...');
  event.waitUntil(
    self.registration.pushManager.subscribe(event.oldSubscription.options)
      .then((newSubscription) => {
        const subJSON = newSubscription.toJSON();
        // Try to get auth token from clients
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          if (clients.length > 0) {
            return clients[0];
          }
          return null;
        }).then(client => {
          if (!client) {
            console.warn('[SW] No client available for push resubscription');
            return;
          }
          // Ask the client page to re-subscribe (it has the auth token)
          client.postMessage({ type: 'PUSH_RESUBSCRIBE' });
        });
      })
      .catch((err) => {
        console.error('[SW] Push subscription renewal failed:', err);
      })
  );
});

// ================================
// FETCH HANDLER (caching)
// ================================

// Fetch: Only handle caching for static assets, NOT API routes
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // IMPORTANT: Never cache API requests - let them always go to network
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Static assets (images, fonts, etc): Cache first
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.woff2')
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // Update cache in background (stale-while-revalidate)
          fetch(request).then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, networkResponse);
              });
            }
          }).catch(() => {});
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Next.js static chunks: Cache first
  if (url.pathname.startsWith('/_next/')) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        return cachedResponse || fetch(request).then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML pages (including /c/{code} customer pages): Network first
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline: try to serve the exact cached page first
          return caches.match(request.url).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            // Fallback to root if customer page not cached
            return caches.match('/').then((rootResponse) => {
              return rootResponse || new Response('Offline - Silakan cek koneksi internet Anda', {
                status: 503,
                headers: { 'Content-Type': 'text/html' }
              });
            });
          });
        })
    );
    return;
  }
});
