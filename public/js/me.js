// On every logged-in page: live notifications and messages, balance, local times.

const $ = (s) => document.querySelector(s);

function bump(id, delta = 1) {
  const node = document.getElementById(id);
  if (!node) return;
  const n = Math.max(0, Number(node.textContent || 0) + delta);
  node.textContent = String(n);
  node.hidden = n === 0;
}

function toast(title, body, url) {
  let box = $('#toasts');
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'toasts' });
    document.body.append(box);
  }
  const a = document.createElement('a');
  a.className = 'toast';
  a.href = url || '#';
  const strong = document.createElement('strong');
  strong.textContent = title;
  a.append(strong);
  if (body) {
    const span = document.createElement('span');
    span.textContent = body;
    a.append(span);
  }
  box.append(a);
  setTimeout(() => a.remove(), 7000);
}

function connect(retry = 1000) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/me`);
  ws.onopen = () => (retry = 1000);
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'balance') {
      const b = document.getElementById('balance');
      if (b) b.textContent = String(msg.balance);
    } else if (msg.type === 'notification') {
      if (msg.url && msg.url.startsWith('/messages/')) return; // messages already have their own notification
      bump('unread-notifications');
      toast(msg.title, msg.body, msg.url);
    } else if (msg.type === 'dm') {
      window.dispatchEvent(new CustomEvent('ftw:dm', { detail: msg }));
      const thread = $('#dm');
      const inThread = thread && (Number(thread.dataset.other) === msg.fromId || (msg.mine && Number(thread.dataset.other) === msg.toId));
      if (!msg.mine && !inThread) {
        bump('unread-messages');
        toast(`Message from ${msg.from}`, msg.body.slice(0, 100), `/messages/${msg.fromId}`);
      }
    }
  };
  ws.onclose = () => setTimeout(() => connect(Math.min(retry * 2, 30000)), retry);
}
connect();

// Times in the browser's time zone.
const fmt = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
document.querySelectorAll('time[data-local]').forEach((t) => {
  const d = new Date(t.getAttribute('datetime'));
  if (!Number.isNaN(d.getTime())) t.textContent = fmt.format(d);
});
// Forms with dates: tell the server the browser's time zone offset.
document.querySelectorAll('input[name=tzOffset]').forEach((i) => (i.value = String(new Date().getTimezoneOffset())));
