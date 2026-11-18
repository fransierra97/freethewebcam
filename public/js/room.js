// Viewer room: video, chat, reactions, tips, tip menu, polls,
// ticketed shows, private shows with cam2cam, and moderation (if you are a moderator).
import { $, api, chatLine, connectRoom, effects, el, joinLive, publishSelf, renderGoal, renderPoll, setBalance, unpublishSelf } from './common.js';

const root = $('#room');
const creatorId = Number(root.dataset.creatorId);
const isOwner = root.dataset.owner === '1';
const video = $('#video');
const chat = $('#chat');
const result = $('#action-result');
const fx = effects($('#fx'));
const selfView = $('#self-view');

let state = { live: false, inPrivate: false };
let me = { canModerate: false, hasTicket: false };
let hlsMode = false;
let hlsPlayer = null;
let myPrivate = null; // { id, status, cam2cam }
let liveRoom = null;
let joining = false;
let goalReached = false;
const hlsToggle = $('#hls-toggle');

const say = (text) => {
  if (result) result.textContent = text;
  else fx.banner(text);
};

// ---------- Video ----------

async function playHls(url) {
  const v = document.createElement('video');
  v.controls = true;
  v.playsInline = true;
  v.autoplay = true;
  if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;
  } else {
    const { default: Hls } = await import('/vendor/hls.light.min.mjs');
    hlsPlayer = new Hls({ enableWorker: false, liveSyncDurationCount: 3 });
    hlsPlayer.loadSource(url);
    hlsPlayer.attachMedia(v);
  }
  return v;
}

function stopHls() {
  if (hlsPlayer) hlsPlayer.destroy();
  hlsPlayer = null;
}

if (hlsToggle) {
  hlsToggle.addEventListener('click', () => {
    hlsMode = !hlsMode;
    hlsToggle.textContent = hlsMode ? 'Back to real-time live video' : 'Lite mode (more delay, less data)';
    syncVideo(true);
  });
}

async function leaveLive() {
  if (liveRoom) {
    const r = liveRoom;
    liveRoom = null;
    await r.disconnect();
  }
  if (selfView) selfView.hidden = true;
}

function placeholder(text) {
  video.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }));
}

function desiredTarget() {
  if (myPrivate && myPrivate.status === 'active') return `private:${myPrivate.id}${myPrivate.cam2cam ? ':cam' : ''}`;
  const ticket = state.ticketShow;
  if (state.live && ticket && ticket.status === 'live') return me.hasTicket ? `ticket:${ticket.id}` : null;
  return state.live && !state.inPrivate ? 'public' : null;
}

function offlineText() {
  if (!state.live) return 'Offline. Come back later.';
  if (state.ticketShow && state.ticketShow.status === 'live') return 'Ticketed show in progress. Buy a ticket to watch it.';
  return 'In a private show. Come back in a few minutes.';
}

/** Decides which video to show: public, my private show, the ticketed show, or nothing. */
async function syncVideo(force = false) {
  if (isOwner || joining) return;
  let target = desiredTarget();
  if (hlsToggle) hlsToggle.hidden = !(state.hlsUrl && target === 'public');
  if (target === 'public' && hlsMode && state.hlsUrl) target = 'hls';
  if (force) {
    stopHls();
    await leaveLive();
  }
  if (target === 'hls') {
    if (hlsPlayer || video.querySelector('video[data-hls]')) return;
    await leaveLive();
    const v = await playHls(state.hlsUrl);
    v.dataset.hls = '1';
    video.replaceChildren(v);
    return;
  }
  stopHls();
  if (target && liveRoom && liveRoom._ftwTarget === target) return;
  await leaveLive();
  if (!target) return placeholder(offlineText());
  joining = true;
  try {
    placeholder('Connecting…');
    const opts = { creatorId, publish: false, container: video };
    if (target.startsWith('private:')) opts.showId = myPrivate.id;
    if (target.startsWith('ticket:')) opts.ticketId = state.ticketShow.id;
    const room = await joinLive(opts);
    room._ftwTarget = target;
    liveRoom = room;
    if (target.startsWith('private:') && myPrivate.cam2cam) await publishSelf(room, selfView);
  } catch (err) {
    placeholder(`Could not connect to the video: ${err.message}`);
  } finally {
    joining = false;
  }
  if (desiredTarget() !== target && target !== 'hls') syncVideo();
}

// ---------- Private show and cam2cam ----------

const cam2camButton = $('#cam2cam');

function renderPrivate() {
  const req = $('#private-request');
  if (!req) return;
  const status = $('#private-status');
  req.hidden = Boolean(myPrivate);
  $('#private-cancel').hidden = !(myPrivate && myPrivate.status === 'requested');
  $('#private-end').hidden = !(myPrivate && myPrivate.status === 'active');
  $('#private-chat-box').hidden = !(myPrivate && myPrivate.status === 'active');
  if (cam2camButton) {
    cam2camButton.hidden = !(myPrivate && myPrivate.status === 'active');
    const price = Number(cam2camButton.dataset.price || 0);
    cam2camButton.textContent = myPrivate && myPrivate.cam2cam ? '📷 Turn off my camera' : `📷 Turn on my camera${price ? ` (+${price} tk/min)` : ''}`;
  }
  if (!myPrivate) status.textContent = '';
  else if (myPrivate.status === 'requested') status.textContent = 'Request sent. Waiting for a response…';
  else status.textContent = myPrivate.cam2cam ? 'In a private show with your camera on. Billed every minute.' : 'You are in a private show. Billed every minute.';
}

if (cam2camButton) {
  cam2camButton.addEventListener('click', async () => {
    if (!myPrivate) return;
    const on = !myPrivate.cam2cam;
    try {
      await api(`/api/private/${myPrivate.id}/cam2cam`, { on });
      myPrivate.cam2cam = on;
      if (!on && liveRoom) await unpublishSelf(liveRoom, selfView);
      renderPrivate();
      syncVideo(); // reconnect with permission to publish (or without it)
    } catch (err) {
      say(err.message);
    }
  });
}

// ---------- Ticketed show ----------

async function refreshMe() {
  try {
    me = await api(`/api/rooms/${creatorId}/me`);
  } catch {}
}

function renderTicket() {
  const box = $('#ticket');
  if (!box) return;
  const t = state.ticketShow;
  box.hidden = !t;
  if (!t) return;
  const when = t.status === 'live' ? 'Live now' : 'Starting soon';
  $('#ticket-info').textContent = `“${t.title}” · ${t.price} tokens · ${when} · ${t.sold} tickets sold${me.hasTicket ? ' · You have a ticket ✔' : ''}`;
  $('#ticket-buy').hidden = me.hasTicket;
}

const ticketBuy = $('#ticket-buy');
if (ticketBuy) {
  ticketBuy.addEventListener('click', async () => {
    try {
      const r = await api('/api/tickets/buy', { creatorId });
      setBalance(r.balance);
      me.hasTicket = true;
      renderTicket();
      say('Ticket purchased!');
      syncVideo();
    } catch (err) {
      say(err.message);
    }
  });
}

// ---------- Poll ----------

async function votePoll(option) {
  try {
    await api('/api/poll/vote', { creatorId, option, times: 1 });
    say('Vote recorded.');
  } catch (err) {
    say(err.message);
  }
}

// ---------- Chat and moderation ----------

function moderation(li, msg) {
  if (!me.canModerate || msg.type !== 'chat' || msg.owner || !msg.userId) return;
  const box = el('span', '', { class: 'mod-actions' });
  const act = (label, body, confirmText) => {
    const b = el('button', label);
    b.onclick = async () => {
      if (confirmText && !confirm(confirmText)) return;
      await api(`/api/rooms/${creatorId}/mod`, body).catch((e) => say(e.message));
    };
    return b;
  };
  box.append(
    act('Delete', { action: 'delete', messageId: msg.id }),
    act('Mute 10 min', { action: 'mute', userId: msg.userId, minutes: 10 }),
  );
  const ban = el('button', 'Ban');
  ban.onclick = async () => {
    if (!confirm(`Ban ${msg.user} from the room?`)) return;
    await api(`/api/rooms/${creatorId}/ban`, { userId: msg.userId }).catch((e) => say(e.message));
  };
  box.append(ban);
  li.append(box);
}

const socket = connectRoom(creatorId, async (msg) => {
  // Personal notifications reach all your tabs: ignore those from other rooms.
  if (msg.creatorId !== undefined && msg.creatorId !== creatorId) return;
  switch (msg.type) {
    case 'state': {
      const ticketChanged = JSON.stringify(state.ticketShow ?? null) !== JSON.stringify(msg.ticketShow ?? null);
      state = msg;
      $('#status').classList.toggle('live', Boolean(msg.live && !msg.inPrivate));
      $('#status').textContent = !msg.live ? 'Offline' : msg.ticketShow?.status === 'live' ? 'Ticketed show' : msg.inPrivate ? 'In a private show' : 'Live';
      $('#viewers').textContent = msg.viewers;
      if (msg.title) $('#room-title').textContent = msg.title;
      const reached = msg.goal && msg.goal.progress >= msg.goal.tokens;
      if (reached && !goalReached && msg.live) {
        fx.banner('🎯 Goal reached!');
        for (let i = 0; i < 18; i++) fx.reaction('🎉', i * 60);
      }
      goalReached = Boolean(reached);
      renderGoal($('#goal'), msg.goal);
      renderPoll($('#poll'), msg.poll, isOwner ? null : votePoll);
      if (ticketChanged) await refreshMe();
      renderTicket();
      syncVideo();
      break;
    }
    case 'me':
      me.canModerate = msg.canModerate;
      break;
    case 'viewers':
      $('#viewers').textContent = msg.count;
      break;
    case 'balance':
      setBalance(msg.balance);
      break;
    case 'poll':
      state.poll = msg.poll;
      renderPoll($('#poll'), msg.poll, isOwner ? null : votePoll);
      break;
    case 'ticket':
      me.hasTicket = msg.hasTicket;
      renderTicket();
      syncVideo();
      break;
    case 'reaction':
      fx.reaction(msg.emoji);
      break;
    case 'chat_delete': {
      const li = chat.querySelector(`li[data-id="${CSS.escape(msg.id)}"]`);
      if (li) li.remove();
      break;
    }
    case 'private_update':
      if (['requested', 'active'].includes(msg.status)) {
        myPrivate = { id: msg.id, status: msg.status, cam2cam: msg.cam2cam ?? (myPrivate && myPrivate.id === msg.id ? myPrivate.cam2cam : false) };
      } else if (myPrivate && myPrivate.id === msg.id) {
        myPrivate = null;
        const why = { declined: 'Your request was declined.', cancelled: 'Request cancelled.', ended: 'The private show has ended.' }[msg.status];
        say(`${why}${msg.reason ? ` (${msg.reason})` : ''}`);
      }
      renderPrivate();
      syncVideo();
      break;
    case 'private_chat':
      chatLine($('#private-chat'), msg);
      break;
    case 'tip':
      chatLine(chat, msg);
      fx.tip(msg);
      break;
    case 'raffle':
      chatLine(chat, msg);
      fx.banner(`🎉 ${msg.winner} wins: ${msg.prize}`);
      break;
    case 'chat':
    case 'system':
      chatLine(chat, msg, moderation);
  }
});

$('#chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = ev.target.elements.text;
  socket.send({ type: 'chat', text: input.value });
  input.value = '';
});

document.querySelectorAll('#reactions button').forEach((b) =>
  b.addEventListener('click', () => {
    socket.send({ type: 'react', emoji: b.dataset.emoji });
  }),
);

const privateChat = $('#private-chat-form');
if (privateChat) {
  privateChat.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = ev.target.elements.text;
    if (myPrivate) socket.send({ type: 'private_chat', showId: myPrivate.id, text: input.value });
    input.value = '';
  });
}

async function tip(amount, message = '') {
  try {
    const r = await api('/api/tip', { creatorId, amount, message });
    setBalance(r.balance);
    say(`You sent ${amount} tokens.`);
  } catch (err) {
    say(err.message);
  }
}

const tipForm = $('#tip-form');
if (tipForm) {
  tipForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    tip(Number(f.amount.value), f.message.value);
    f.message.value = '';
  });
  document.querySelectorAll('.quick-tip').forEach((b) => b.addEventListener('click', () => tip(Number(b.dataset.amount))));
  document.querySelectorAll('.menu-item').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const r = await api(`/api/menu/${b.dataset.itemId}`, {});
        setBalance(r.balance);
        say('Request sent.');
      } catch (err) {
        say(err.message);
      }
    }),
  );
  $('#private-request').addEventListener('click', async () => {
    try {
      const r = await api('/api/private/request', { creatorId });
      myPrivate = { id: r.id, status: r.status, cam2cam: false };
      renderPrivate();
    } catch (err) {
      say(err.message);
    }
  });
  $('#private-cancel').addEventListener('click', () => myPrivate && api(`/api/private/${myPrivate.id}/cancel`, {}).catch((e) => say(e.message)));
  $('#private-end').addEventListener('click', () => myPrivate && api(`/api/private/${myPrivate.id}/end`, {}).catch((e) => say(e.message)));
}
renderPrivate();
refreshMe().then(renderTicket);
