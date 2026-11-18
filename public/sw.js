// Service worker: shows push notifications and opens the page when they are clicked.
self.addEventListener('push', (event) => {
  let data = { title: 'Notification', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url }, tag: 'ftw' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  // Same-site URLs only.
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
