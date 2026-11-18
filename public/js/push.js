// Enable or disable browser notifications (Web Push).
const box = document.querySelector('#push');
const status = document.querySelector('#push-status');
const on = document.querySelector('#push-on');
const off = document.querySelector('#push-off');
const key = box.dataset.vapid;

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
}

async function refresh() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    status.textContent = 'This browser does not support notifications.';
    return;
  }
  if (Notification.permission === 'denied') {
    status.textContent = 'You have blocked notifications for this site in your browser.';
    return;
  }
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const sub = await reg.pushManager.getSubscription();
  status.textContent = sub ? 'Notifications are enabled in this browser.' : 'Notifications are disabled in this browser.';
  on.hidden = Boolean(sub);
  off.hidden = !sub;
}

on.addEventListener('click', async () => {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    if ((await Notification.requestPermission()) !== 'granted') return refresh();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/api/push/subscribe', sub.toJSON());
  } catch (err) {
    status.textContent = `Could not enable: ${err.message}`;
    return;
  }
  refresh();
});

off.addEventListener('click', async () => {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  refresh();
});

refresh();
