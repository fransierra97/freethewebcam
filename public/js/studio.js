// Creator studio: broadcasting, live panel, tools (polls, giveaways, ticketed shows),
// moderated chat, and private shows (with the viewer's camera if they enable cam2cam).
import { $, api, chatLine, connectRoom, effects, el, joinLive, renderGoal, renderPoll } from './common.js';

const root = $('#studio');
const creatorId = Number(root.dataset.creatorId);
const preview = $('#preview');
const goLive = $('#go-live');
const stopLive = $('#stop-live');
const testButton = $('#go-live-test');
const fx = effects($('#fx'));
const viewerCam = $('#viewer-cam');

let state = { live: false, inPrivate: false };
let room = null; // LiveKit room we are publishing to right now
let roomTarget = null; // 'public' | 'private' | 'ticket'
let publishing = false; // does the creator want to be broadcasting?
let mode = 'browser';
let activePrivate = null; // { id, viewer, startedAt, cam2cam }
let minuteTimer = null;
let useTestPattern = false;
let frameTimer = null;
let statsTimer = null;

// ---------- Control frames (moderation) ----------

function startFrames() {
  clearInterval(frameTimer);
  const seconds = Number(root.dataset.frameInterval || 0);
  if (!seconds) return;
  const send = async () => {
    const video = preview.querySelector('video');
    if (!video || !video.videoWidth || !publishing) return;
    const scale = Math.min(1, 640 / video.videoWidth);
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) });
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.7));
    if (blob) fetch('/api/moderation/frame', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob, credentials: 'same-origin' }).catch(() => {});
  };
  setTimeout(send, 3000);
  frameTimer = setInterval(send, seconds * 1000);
}

// ---------- Broadcasting ----------

async function leave() {
  if (room) {
    const r = room;
    room = null;
    roomTarget = null;
    await r.disconnect();
  }
  if (viewerCam) viewerCam.hidden = true;
}

function wantedTarget() {
  if (activePrivate) return 'private';
  if (state.ticketShow && state.ticketShow.status === 'live') return 'ticket';
  return 'public';
}

/** Publishes to the right room: the private show, the ticketed show, or the public one. */
async function publishTo(target) {
  if (mode === 'obs') return;
  await leave();
  preview.replaceChildren(el('p', 'Connecting camera…'));
  try {
    room = await joinLive({
      creatorId,
      showId: target === 'private' ? activePrivate.id : undefined,
      ticketId: target === 'ticket' ? state.ticketShow.id : undefined,
      publish: true,
      container: preview,
      remote: target === 'private' ? viewerCam : undefined,
      testPattern: useTestPattern,
      label: root.dataset.name,
    });
    roomTarget = target;
  } catch (err) {
    preview.replaceChildren(el('p', `Could not broadcast: ${err.message}`));
  }
}

async function syncPublishing() {
  if (!publishing || mode === 'obs' || !state.live) return;
  const target = wantedTarget();
  if (target !== roomTarget) await publishTo(target);
}

function renderButtons() {
  goLive.hidden = state.live && Boolean(room);
  if (testButton) testButton.hidden = goLive.hidden;
  goLive.textContent = state.live ? 'Reconnect camera' : 'Go live';
  stopLive.hidden = !state.live;
  $('#tools').hidden = !state.live;
  $('#stats').hidden = !state.live;
}

function selectedMode() {
  const checked = document.querySelector('#mode input[name=mode]:checked');
  return checked ? checked.value : 'browser';
}

/** In OBS mode we do not publish: we subscribe to our own room to see the signal. */
async function previewObs() {
  await leave();
  preview.replaceChildren(el('p', 'Waiting for the OBS signal… click “Start Streaming” in OBS.'));
  try {
    room = await joinLive({ creatorId, publish: false, container: preview });
    roomTarget = 'public';
  } catch (err) {
    preview.replaceChildren(el('p', `Could not connect: ${err.message}`));
  }
}

async function start(test) {
  useTestPattern = test;
  mode = test ? 'browser' : selectedMode();
  try {
    const performers = [...document.querySelectorAll('#performers input[name=performer]:checked')].map((i) => Number(i.value));
    await api('/api/studio/live', { on: true, performers, mode });
    document.querySelectorAll('#performers input, #mode input').forEach((i) => (i.disabled = true));
    publishing = true;
    if (mode === 'obs') await previewObs();
    else await publishTo(wantedTarget());
    startFrames();
    startStats();
  } catch (err) {
    alert(err.message);
  }
  renderButtons();
}
goLive.addEventListener('click', () => start(false));
if (testButton) testButton.addEventListener('click', () => start(true));

stopLive.addEventListener('click', async () => {
  publishing = false;
  clearInterval(frameTimer);
  clearInterval(statsTimer);
  await leave();
  preview.replaceChildren(el('p', 'Stream ended.'));
  await api('/api/studio/live', { on: false }).catch((e) => alert(e.message));
  document.querySelectorAll('#performers input, #mode input').forEach((i) => (i.disabled = false));
  renderButtons();
});

// ---------- Live panel ----------

const LABELS = { tip: 'tips', menu: 'tip menu', private: 'private shows', ticket: 'tickets', poll: 'votes', dm: 'messages', album: 'albums' };

async function refreshStats() {
  try {
    const { stats } = await api('/api/studio/stats');
    if (!stats) return;
    $('#st-earned').textContent = `${stats.earnedTokens} tk`;
    $('#st-money').textContent = new Intl.NumberFormat('en', { style: 'currency', currency: stats.currency }).format(stats.earnedMoney);
    $('#st-viewers').textContent = stats.viewers;
    $('#st-peak').textContent = `peak: ${stats.peakViewers}`;
    $('#st-followers').textContent = stats.newFollowers;
    $('#st-fans').replaceChildren(...(stats.topFans.length ? stats.topFans.map((f) => el('li', `${f.name} · ${f.tokens} tk`)) : [el('li', 'Nobody yet.')]));
    $('#st-kinds').textContent = Object.entries(stats.byKind)
      .map(([k, v]) => `${LABELS[k] ?? k}: ${v.tokens} tk (${v.count})`)
      .join(' · ');
    root.dataset.startedAt = stats.startedAt;
  } catch {}
}

function tickDuration() {
  const started = root.dataset.startedAt ? new Date(root.dataset.startedAt).getTime() : 0;
  if (!started) return;
  const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  $('#st-duration').textContent = h ? `${h}:${String(m).padStart(2, '0')} h` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function startStats() {
  clearInterval(statsTimer);
  refreshStats();
  statsTimer = setInterval(() => {
    refreshStats();
  }, 10000);
}
setInterval(tickDuration, 1000);

// ---------- Tools: poll, giveaway, ticketed show ----------

const notice = (text) => chatLine($('#chat'), { type: 'system', text });

$('#poll-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    await api('/api/poll', {
      question: f.question.value,
      options: f.options.value.split('\n'),
      votePrice: Number(f.votePrice.value),
      minutes: Number(f.minutes.value),
    });
    ev.target.reset();
  } catch (err) {
    alert(err.message);
  }
});
$('#poll-close').addEventListener('click', () => api('/api/poll/close', {}).catch((e) => alert(e.message)));

$('#raffle-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    const r = await api('/api/raffle', { prize: f.prize.value, audience: f.audience.value });
    notice(`Giveaway drawn among ${r.entrants}: ${r.winner} wins.`);
    ev.target.reset();
  } catch (err) {
    alert(err.message);
  }
});

function renderTicketTools() {
  const t = state.ticketShow;
  $('#ticket-state').textContent = t ? `“${t.title}” · ${t.price} tk · ${t.sold} tickets · ${t.status === 'live' ? 'LIVE' : 'on sale'}` : 'No show set up.';
  $('#ticket-create').hidden = Boolean(t);
  $('#ticket-start').hidden = !(t && t.status === 'selling');
  $('#ticket-end').hidden = !(t && t.status === 'live');
  $('#ticket-cancel').hidden = !t;
  document.querySelectorAll('#ticket-form label').forEach((l) => (l.hidden = Boolean(t)));
}

$('#ticket-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    await api('/api/tickets/create', { title: f.title.value, price: Number(f.price.value) });
  } catch (err) {
    alert(err.message);
  }
});
$('#ticket-start').addEventListener('click', () => api('/api/tickets/start', {}).catch((e) => alert(e.message)));
$('#ticket-end').addEventListener('click', () => api('/api/tickets/end', {}).catch((e) => alert(e.message)));
$('#ticket-cancel').addEventListener('click', async () => {
  if (!confirm('Cancel the show and refund all tickets?')) return;
  await api('/api/tickets/cancel', {}).catch((e) => alert(e.message));
});

// ---------- Private shows ----------

function renderActivePrivate() {
  const box = $('#private-active');
  box.hidden = !activePrivate;
  clearInterval(minuteTimer);
  $('#private-cam').hidden = !(activePrivate && activePrivate.cam2cam);
  if (!activePrivate) return;
  $('#private-with').textContent = activePrivate.viewer;
  const tick = () => ($('#private-minutes').textContent = String(Math.floor((Date.now() - activePrivate.startedAt) / 60000) + 1));
  tick();
  minuteTimer = setInterval(tick, 5000);
}

function addRequest(msg) {
  const list = $('#private-requests');
  if (list.querySelector(`[data-id="${msg.id}"]`)) return;
  const li = el('li', `${msg.viewer} [${msg.level}] requests a private show (${msg.pricePerMin} tokens/min) `, { 'data-id': String(msg.id) });
  const accept = el('button', 'Accept', { class: 'primary' });
  const decline = el('button', 'Decline');
  accept.onclick = () => api(`/api/private/${msg.id}/accept`, {}).catch((e) => alert(e.message));
  decline.onclick = () => api(`/api/private/${msg.id}/decline`, {}).catch((e) => alert(e.message));
  li.append(accept, ' ', decline);
  li._viewer = msg.viewer;
  list.append(li);
}

$('#private-end').addEventListener('click', () => activePrivate && api(`/api/private/${activePrivate.id}/end`, {}).catch((e) => alert(e.message)));

// ---------- Chat and moderation ----------

function moderation(li, msg) {
  if (msg.type !== 'chat' || msg.owner || !msg.userId) return;
  const box = el('span', '', { class: 'mod-actions' });
  const act = (label, body) => {
    const b = el('button', label);
    b.onclick = () => api(`/api/rooms/${creatorId}/mod`, body).catch((e) => alert(e.message));
    return b;
  };
  const ban = el('button', 'Ban');
  ban.onclick = async () => {
    if (!confirm(`Ban ${msg.user} from your room?`)) return;
    await api(`/api/rooms/${creatorId}/ban`, { userId: msg.userId }).catch((e) => alert(e.message));
  };
  box.append(act('Delete', { action: 'delete', messageId: msg.id }), act('Mute 10 min', { action: 'mute', userId: msg.userId, minutes: 10 }), ban);
  li.append(box);
}

const socket = connectRoom(creatorId, async (msg) => {
  // Personal notifications reach all your tabs: ignore those from other rooms.
  if (msg.creatorId !== undefined && msg.creatorId !== creatorId) return;
  switch (msg.type) {
    case 'state':
      state = msg;
      $('#status').classList.toggle('live', Boolean(msg.live && !msg.inPrivate));
      $('#status').textContent = !msg.live
        ? 'Offline'
        : msg.ticketShow?.status === 'live'
          ? 'Ticketed show'
          : msg.inPrivate
            ? 'In a private show'
            : 'Live (public)';
      $('#viewers').textContent = msg.viewers;
      renderGoal($('#goal'), msg.goal);
      renderPoll($('#poll'), msg.poll, null);
      renderTicketTools();
      renderButtons();
      if (msg.live && !statsTimer) startStats();
      await syncPublishing();
      break;
    case 'viewers':
      $('#viewers').textContent = msg.count;
      break;
    case 'poll':
      state.poll = msg.poll;
      renderPoll($('#poll'), msg.poll, null);
      break;
    case 'reaction':
      fx.reaction(msg.emoji);
      break;
    case 'chat_delete': {
      const li = $('#chat').querySelector(`li[data-id="${CSS.escape(msg.id)}"]`);
      if (li) li.remove();
      break;
    }
    case 'private_request':
      addRequest(msg);
      break;
    case 'private_update': {
      const li = document.querySelector(`#private-requests [data-id="${msg.id}"]`);
      if (msg.status === 'active') {
        if (activePrivate && activePrivate.id === msg.id) {
          if (msg.cam2cam !== undefined) activePrivate.cam2cam = msg.cam2cam;
          renderActivePrivate();
          break;
        }
        activePrivate = {
          id: msg.id,
          viewer: msg.viewer || (li ? li._viewer : 'viewer'),
          startedAt: msg.startedAt ? new Date(msg.startedAt).getTime() : Date.now(),
          cam2cam: Boolean(msg.cam2cam),
        };
        if (li) li.remove();
        renderActivePrivate();
        await syncPublishing();
      } else if (msg.status !== 'requested') {
        if (li) li.remove();
        if (activePrivate && activePrivate.id === msg.id) {
          activePrivate = null;
          renderActivePrivate();
          notice(`Private show ended${msg.reason ? ` (${msg.reason})` : ''}.`);
          await syncPublishing();
        }
      }
      break;
    }
    case 'private_chat':
      chatLine($('#private-chat'), msg);
      break;
    case 'tip':
      chatLine($('#chat'), msg);
      fx.tip(msg);
      refreshStats();
      break;
    case 'raffle':
      chatLine($('#chat'), msg);
      fx.banner(`🎉 ${msg.winner} wins: ${msg.prize}`);
      break;
    case 'chat':
    case 'system':
      chatLine($('#chat'), msg, moderation);
  }
});

$('#chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = ev.target.elements.text;
  socket.send({ type: 'chat', text: input.value });
  input.value = '';
});

$('#private-chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = ev.target.elements.text;
  if (activePrivate) socket.send({ type: 'private_chat', showId: activePrivate.id, text: input.value });
  input.value = '';
});

window.addEventListener('beforeunload', () => leave());
renderButtons();
