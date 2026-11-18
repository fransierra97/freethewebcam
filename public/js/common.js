// Utilities shared by the room and the studio. No dependencies except LiveKit.
import { Room, RoomEvent, Track } from '/vendor/livekit-client.esm.mjs';

export const $ = (sel) => document.querySelector(sel);

export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/** Room WebSocket with automatic reconnection. */
export function connectRoom(creatorId, onMessage) {
  let ws;
  let closedByUs = false;
  let retry = 1000;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/room/${creatorId}`);
    ws.onopen = () => (retry = 1000);
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => {
      if (closedByUs) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  open();
  return {
    send: (msg) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => {
      closedByUs = true;
      ws && ws.close();
    },
  };
}

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
export { el };

/** Renders a chat message. All text goes in via textContent (never HTML). */
export function chatLine(list, msg, extra) {
  const li = el('li');
  if (msg.id) li.dataset.id = msg.id;
  if (msg.type === 'chat') {
    const role = msg.owner ? ' (creator)' : msg.staff ? ' (staff)' : msg.mod ? ' (mod)' : '';
    li.append(el('small', `[${msg.level}] `), el('strong', msg.user + role), document.createTextNode(': ' + msg.text));
  } else if (msg.type === 'raffle') {
    li.className = 'raffle-line';
    li.append(el('strong', `🎉 Giveaway “${msg.prize}”: ${msg.winner} wins`), document.createTextNode(` (out of ${msg.entrants} entrants)`));
  } else if (msg.type === 'tip') {
    const what = msg.label ? `requested “${msg.label}” (${msg.amount} tokens)` : `tipped ${msg.amount} tokens`;
    li.append(el('strong', `★ ${msg.user} [${msg.level}] ${what}`), document.createTextNode(msg.message ? ': ' + msg.message : ''));
  } else if (msg.type === 'private_chat') {
    li.append(el('strong', msg.user), document.createTextNode(': ' + msg.text));
  } else {
    li.append(el('em', msg.text));
  }
  if (extra) extra(li, msg);
  list.append(li);
  while (list.children.length > 200) list.firstChild.remove();
  li.scrollIntoView({ block: 'nearest' });
}

/** Animations over the video: tips, reactions and notices. */
export function effects(layer) {
  const add = (node, ms) => {
    if (!layer) return;
    layer.append(node);
    setTimeout(() => node.remove(), ms);
  };
  return {
    tip(msg) {
      const big = msg.amount >= 100;
      const node = el('div', '', { class: `fx-tip${big ? ' big' : ''}` });
      node.append(el('strong', msg.user), document.createTextNode(msg.label ? ` requested “${msg.label}”` : ` tipped ${msg.amount} tokens`));
      if (msg.message) node.append(el('span', msg.message, { class: 'fx-msg' }));
      add(node, big ? 6000 : 4200);
      const n = Math.min(14, 3 + Math.floor(msg.amount / 25));
      for (let i = 0; i < n; i++) this.reaction(big ? '💎' : '✨', i * 70);
    },
    reaction(emoji, delay = 0) {
      setTimeout(() => {
        const node = el('span', emoji, { class: 'fx-float' });
        node.style.left = `${8 + Math.random() * 84}%`;
        node.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 120)}px`);
        add(node, 3200);
      }, delay);
    },
    banner(text) {
      add(el('div', text, { class: 'fx-banner' }), 5000);
    },
  };
}

/** Renders a poll. onVote(index) is only for those who can vote. */
export function renderPoll(node, poll, onVote) {
  if (!node) return;
  node.hidden = !poll;
  if (!poll) return node.replaceChildren();
  const open = poll.status === 'open' && new Date(poll.endsAt).getTime() > Date.now();
  const head = el('div', '', { class: 'poll-head' });
  head.append(el('strong', poll.question), el('small', open ? (poll.votePrice ? `${poll.votePrice} tk per vote` : 'Free vote') : 'Closed'));
  const list = el('ul', '', { class: 'poll-options' });
  poll.options.forEach((label, i) => {
    const pct = poll.total ? Math.round((poll.votes[i] / poll.total) * 100) : 0;
    const li = el('li');
    const bar = el('span', '', { class: 'poll-bar' });
    bar.style.width = `${pct}%`;
    li.append(bar, el('span', label, { class: 'poll-label' }), el('span', `${poll.votes[i]} · ${pct}%`, { class: 'poll-count' }));
    if (open && onVote) {
      li.classList.add('votable');
      li.tabIndex = 0;
      li.onclick = () => onVote(i);
    }
    list.append(li);
  });
  node.replaceChildren(head, list);
}

export function renderGoal(node, goal) {
  if (!node) return;
  node.textContent = goal ? `Goal: ${goal.label} — ${Math.min(goal.progress, goal.tokens)}/${goal.tokens} tokens${goal.progress >= goal.tokens ? ' reached!' : ''}` : '';
}

export function setBalance(value) {
  const node = document.getElementById('balance');
  if (node) node.textContent = String(value);
}

/** Synthetic video (no camera) for demos and tests. */
function testPatternTrack(label) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const g = canvas.getContext('2d');
  const started = Date.now();
  const draw = () => {
    const t = (Date.now() - started) / 1000;
    g.fillStyle = `hsl(${(t * 40) % 360}, 60%, 35%)`;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff';
    g.font = '28px sans-serif';
    g.fillText(`Test image · ${label}`, 30, 60);
    g.font = '64px monospace';
    g.fillText(new Date().toLocaleTimeString(), 30, 200);
    g.beginPath();
    g.arc(320 + Math.cos(t) * 220, 300, 20, 0, Math.PI * 2);
    g.fill();
  };
  // setInterval (not requestAnimationFrame) so it keeps streaming while the tab is in the background.
  const timer = setInterval(() => (track.readyState === 'ended' ? clearInterval(timer) : draw()), 1000 / 30);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  draw();
  return track;
}

/** Joins a LiveKit room. If publish is true, publishes camera and microphone (or the test image). */
export async function joinLive({ creatorId, showId, ticketId, publish, container, remote, testPattern, label = '' }) {
  const query = showId ? `show=${showId}` : ticketId ? `ticket=${ticketId}` : `creator=${creatorId}`;
  const { url, token } = await api(`/api/live/token?${query}`);
  const room = new Room({ adaptiveStream: true, dynacast: true });
  room.on(RoomEvent.TrackSubscribed, (track) => {
    // The publisher sees others (e.g. the viewer's camera in cam2cam) in a separate box.
    if (remote) {
      remote.hidden = false;
      if (track.kind === Track.Kind.Video) remote.replaceChildren(track.attach());
      else remote.append(track.attach());
      return;
    }
    if (track.kind === Track.Kind.Video) {
      const video = track.attach();
      video.playsInline = true;
      container.querySelectorAll('video, p').forEach((n) => n.remove());
      container.prepend(video);
    } else if (track.kind === Track.Kind.Audio) {
      container.append(track.attach());
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((m) => m.remove());
    if (remote && !remote.querySelector('video')) remote.hidden = true;
  });
  // Browsers block autoplay audio until the user interacts with the page.
  const soundButton = el('button', 'Enable sound');
  soundButton.onclick = () => room.startAudio();
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (room.canPlaybackAudio) soundButton.remove();
    else container.append(soundButton);
  });
  await room.connect(url, token);
  if (!publish && !room.canPlaybackAudio) container.append(soundButton);
  if (publish && testPattern) {
    const track = testPatternTrack(label);
    await room.localParticipant.publishTrack(track, { source: Track.Source.Camera, name: 'test-pattern' });
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    container.replaceChildren(video);
  } else if (publish) {
    await room.localParticipant.enableCameraAndMicrophone();
    const cam = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (cam && cam.videoTrack) {
      const video = cam.videoTrack.attach();
      video.muted = true;
      container.replaceChildren(video);
    }
  }
  return room;
}

/** Publishes the viewer's camera (cam2cam) and shows it in its own box. */
export async function publishSelf(room, box) {
  await room.localParticipant.enableCameraAndMicrophone();
  const cam = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if (cam && cam.videoTrack && box) {
    const v = cam.videoTrack.attach();
    v.muted = true;
    box.replaceChildren(v);
    box.hidden = false;
  }
}

export async function unpublishSelf(room, box) {
  await room.localParticipant.setCameraEnabled(false);
  await room.localParticipant.setMicrophoneEnabled(false);
  if (box) {
    box.replaceChildren();
    box.hidden = true;
  }
}
