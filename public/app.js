const API = '/api/torrents';

const addForm = document.getElementById('add-form');
const torrentInput = document.getElementById('torrent-input');
const addBtn = document.getElementById('add-btn');
const addError = document.getElementById('add-error');
const torrentList = document.getElementById('torrent-list');
const playerSection = document.getElementById('player-section');
const player = document.getElementById('player');
const playerInfo = document.getElementById('player-info');
const compatBtn = document.getElementById('compat-btn');
const hlsControls = document.getElementById('hls-controls');
const hlsPlayPauseBtn = document.getElementById('hls-playpause');
const hlsBack10Btn = document.getElementById('hls-back10');
const hlsFwd10Btn = document.getElementById('hls-fwd10');
const hlsCurrentLabel = document.getElementById('hls-current-time');
const hlsDurationLabel = document.getElementById('hls-duration');
const hlsSeek = document.getElementById('hls-seek');

let torrents = [];
let pollTimer = null;
let currentPlaying = null;

function bytesToSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function speedToText(bytesPerSec) {
  return `${bytesToSize(bytesPerSec)}/s`;
}

async function fetchTorrents() {
  const res = await fetch(API);
  torrents = await res.json();
  render();
}

async function addTorrent(torrentId) {
  addError.classList.add('hidden');
  addBtn.disabled = true;
  addBtn.textContent = 'Adding…';
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrentId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add torrent');
    torrentInput.value = '';
    await fetchTorrents();
  } catch (err) {
    addError.textContent = err.message;
    addError.classList.remove('hidden');
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = 'Add';
  }
}

async function removeTorrent(infoHash) {
  if (currentPlaying && currentPlaying.infoHash === infoHash) stopPlayback();
  await fetch(`${API}/${infoHash}`, { method: 'DELETE' });
  await fetchTorrents();
}

// The server only keeps downloading/serving a file while it's hearing from a client - see the
// comment above WATCH_TIMEOUT_MS in torrentManager.js. Without this, closing the tab (or just
// navigating to a different file) wouldn't stop it: nothing would tell the server playback
// actually stopped, so it'd keep fetching data - notably an HLS session, which keeps transcoding
// on its own schedule regardless of whether anyone's still fetching segments - until the much
// longer full idle-reset kicked in.
const HEARTBEAT_INTERVAL_MS = 5000;
let heartbeatTimer = null;

function sendHeartbeat() {
  if (!currentPlaying) return;
  const position = hlsState ? currentHlsDisplayTime() : (player.currentTime || 0);
  const body = JSON.stringify({ fileIndex: currentPlaying.file.index, position });
  try {
    navigator.sendBeacon(`${API}/${currentPlaying.infoHash}/heartbeat`, new Blob([body], { type: 'application/json' }));
  } catch {
    // sendBeacon isn't available/failed - the server will just consider this file unwatched
    // sooner, which is a safe direction to fail in.
  }
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function stopPlayback() {
  stopHeartbeat();
  exitHlsMode();
  player.pause();
  player.removeAttribute('src');
  player.load();
  playerSection.classList.add('hidden');
  currentPlaying = null;
}

// iOS's browser engine (WebKit - true of "Chrome" on iOS too, Apple requires every iOS browser
// to use it) can't play most torrent containers/codecs directly (e.g. .mkv, HEVC, AC3/DTS), and
// unlike desktop/Android it also can't fall back to a live fragmented-MP4 stream - it only plays
// video streamed as HLS. So iOS gets routed straight to /hls instead of /transcode.
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const STALL_TIMEOUT_MS = 8000;
let stallTimer = null;

function clearStallTimer() {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = null;
}

// Watches for silent failures: some mobile browsers never fire an `error` event for an
// unsupported/stuck stream, they just sit there with a spinner forever. If we don't reach
// HAVE_CURRENT_DATA within STALL_TIMEOUT_MS, treat it as a failure and move to the next fallback.
function armStallTimer(onStall) {
  clearStallTimer();
  stallTimer = setTimeout(() => {
    if (player.readyState < 2) onStall();
  }, STALL_TIMEOUT_MS);
  player.addEventListener('loadeddata', clearStallTimer, { once: true });
}

function playFile(infoHash, file) {
  currentPlaying = { infoHash, file };
  playerSection.classList.remove('hidden');
  playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startHeartbeat();
  playDirect(infoHash, file);
}

// Some containers/codecs (e.g. .mkv with HEVC/DTS) aren't supported by every device's
// browser - notably most phones. If direct playback fails (or silently stalls), fall back
// to a transcoded stream.
function playDirect(infoHash, file) {
  exitHlsMode();
  const fallback = IS_IOS ? () => playHls(infoHash, file) : () => playTranscoded(infoHash, file);
  player.onerror = fallback;
  player.src = `/stream/${infoHash}/${file.index}`;
  playerInfo.textContent = file.name;
  compatBtn.classList.remove('hidden');
  compatBtn.textContent = 'Having trouble playing? Try compatibility mode';
  compatBtn.disabled = false;
  armStallTimer(fallback);
  player.play().catch(() => {});
}

function playTranscoded(infoHash, file) {
  exitHlsMode();
  player.onerror = null;
  clearStallTimer();
  player.src = `/transcode/${infoHash}/${file.index}`;
  playerInfo.textContent = `${file.name} (compatibility mode - seeking disabled)`;
  compatBtn.textContent = 'Playing in compatibility mode';
  compatBtn.disabled = true;
  player.play().catch(() => {});
}

// ---- HLS playback + seeking (iOS compatibility mode) ----
// iOS plays .m3u8 natively via a plain <video src>, no library needed. Native iOS HLS doesn't
// let JS intercept seek gestures over the network, so real seeking is implemented here instead:
// dragging the custom timeline (or the +/-10s buttons) reloads the player pointed at a new
// `?t=<seconds>` offset, which tells the server to restart transcoding from that point. Since the
// new stream's own internal clock restarts at 0, `hlsState.seekBase` tracks where in the real
// video that restart point was, so displayed time = seekBase + player.currentTime.
let hlsState = null; // { infoHash, file, seekBase, duration }
let hlsSeekDragging = false;

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function currentHlsDisplayTime() {
  return hlsState ? hlsState.seekBase + (player.currentTime || 0) : 0;
}

async function fetchDuration(infoHash, fileIndex) {
  try {
    const res = await fetch(`${API}/${infoHash}/files/${fileIndex}/duration`);
    const data = await res.json();
    return data.duration || null;
  } catch {
    return null;
  }
}

function updateHlsUi() {
  if (!hlsState) return;
  hlsDurationLabel.textContent = hlsState.duration ? formatTime(hlsState.duration) : '--:--';
  hlsSeek.disabled = !hlsState.duration;
  if (hlsState.duration) hlsSeek.max = String(Math.floor(hlsState.duration));
}

function playHls(infoHash, file, startSeconds = 0) {
  const isNewFile = !hlsState || hlsState.infoHash !== infoHash || hlsState.file.index !== file.index;
  const duration = isNewFile ? null : hlsState.duration;
  hlsState = { infoHash, file, seekBase: startSeconds, duration };

  player.onerror = null;
  clearStallTimer();
  hlsControls.classList.remove('hidden');
  playerInfo.textContent = `${file.name} (compatibility mode)`;
  compatBtn.textContent = 'Playing in compatibility mode';
  compatBtn.disabled = true;

  const t = Math.round(startSeconds);
  player.src = `/hls/${infoHash}/${file.index}/playlist.m3u8${t > 0 ? `?t=${t}` : ''}`;
  player.load();
  player.play().catch(() => {});

  updateHlsUi();
  hlsCurrentLabel.textContent = formatTime(startSeconds);
  if (!hlsSeekDragging) hlsSeek.value = String(Math.floor(startSeconds));

  if (isNewFile) {
    fetchDuration(infoHash, file.index).then((fetchedDuration) => {
      if (hlsState && hlsState.infoHash === infoHash && hlsState.file.index === file.index) {
        hlsState.duration = fetchedDuration;
        updateHlsUi();
      }
    });
  }
}

function exitHlsMode() {
  if (!hlsState) return;
  hlsState = null;
  hlsControls.classList.add('hidden');
}

function seekHlsTo(targetSeconds) {
  if (!hlsState) return;
  let target = Math.max(0, targetSeconds);
  if (hlsState.duration) target = Math.min(target, hlsState.duration);
  playHls(hlsState.infoHash, hlsState.file, target);
}

player.addEventListener('timeupdate', () => {
  if (!hlsState) return;
  const t = currentHlsDisplayTime();
  hlsCurrentLabel.textContent = formatTime(t);
  if (!hlsSeekDragging) hlsSeek.value = String(Math.floor(t));
});

player.addEventListener('play', () => { hlsPlayPauseBtn.textContent = '⏸'; });
player.addEventListener('pause', () => { hlsPlayPauseBtn.textContent = '▶'; });

hlsPlayPauseBtn.addEventListener('click', () => {
  if (player.paused) player.play().catch(() => {});
  else player.pause();
});

hlsBack10Btn.addEventListener('click', () => seekHlsTo(currentHlsDisplayTime() - 10));
hlsFwd10Btn.addEventListener('click', () => seekHlsTo(currentHlsDisplayTime() + 10));

hlsSeek.addEventListener('input', () => {
  hlsSeekDragging = true;
  hlsCurrentLabel.textContent = formatTime(Number(hlsSeek.value));
});
hlsSeek.addEventListener('change', () => {
  hlsSeekDragging = false;
  seekHlsTo(Number(hlsSeek.value));
});

compatBtn.addEventListener('click', () => {
  if (!currentPlaying) return;
  if (IS_IOS) playHls(currentPlaying.infoHash, currentPlaying.file);
  else playTranscoded(currentPlaying.infoHash, currentPlaying.file);
});

function render() {
  torrentList.innerHTML = '';
  if (torrents.length === 0) {
    torrentList.innerHTML = '<p class="meta">No torrents added yet.</p>';
    return;
  }

  for (const t of torrents) {
    const card = document.createElement('div');
    card.className = 'torrent-card';

    const progressPct = Math.round((t.progress || 0) * 100);

    card.innerHTML = `
      <div class="row">
        <h3>${t.name || t.infoHash}</h3>
        <button class="remove-btn" data-hash="${t.infoHash}">Remove</button>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${progressPct}%"></div></div>
      <p class="meta">
        ${progressPct}% · ${bytesToSize(t.length)} · ⬇ ${speedToText(t.downloadSpeed)} · ⬆ ${speedToText(t.uploadSpeed)} · ${t.numPeers} peers
      </p>
      <div class="file-list"></div>
    `;

    const fileList = card.querySelector('.file-list');
    for (const f of t.files) {
      const row = document.createElement('div');
      row.className = `file-row ${f.playable ? '' : 'not-playable'}`;
      row.innerHTML = `
        <span class="file-name">${f.name}</span>
        <span class="meta">${bytesToSize(f.length)}</span>
        ${f.playable ? '<button class="play-btn">Play</button>' : ''}
      `;
      if (f.playable) {
        row.querySelector('.play-btn').addEventListener('click', () => playFile(t.infoHash, f));
      }
      fileList.appendChild(row);
    }

    card.querySelector('.remove-btn').addEventListener('click', () => removeTorrent(t.infoHash));
    torrentList.appendChild(card);
  }
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = torrentInput.value.trim();
  if (value) addTorrent(value);
});

fetchTorrents();
pollTimer = setInterval(fetchTorrents, 2000);
