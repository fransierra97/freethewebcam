// Conversation: new messages appear without reloading.
const box = document.querySelector('#dm');
const list = document.querySelector('#dm-list');
const other = Number(box.dataset.other);
list.lastElementChild?.scrollIntoView({ block: 'end' });

window.addEventListener('ftw:dm', (ev) => {
  const m = ev.detail;
  const mine = Boolean(m.mine);
  if ((mine && m.toId !== other) || (!mine && m.fromId !== other)) return;
  const li = document.createElement('li');
  if (mine) li.className = 'mine';
  const bubble = document.createElement('span');
  bubble.className = 'bubble';
  bubble.textContent = m.body;
  const small = document.createElement('small');
  small.textContent = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { timeStyle: 'short' }).format(new Date(m.at));
  li.append(bubble, small);
  list.append(li);
  li.scrollIntoView({ block: 'end', behavior: 'smooth' });
  // Mark as read when seen.
  if (!mine) fetch(location.pathname, { credentials: 'same-origin' }).catch(() => {});
});
