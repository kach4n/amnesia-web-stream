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
  await fetch(`${API}/${infoHash}`, { method: 'DELETE' });
  await fetchTorrents();
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
  playDirect(infoHash, file);
}

// Some containers/codecs (e.g. .mkv with HEVC/DTS) aren't supported by every device's
// browser - notably most phones. If direct playback fails (or silently stalls), fall back
// to a transcoded stream.
function playDirect(infoHash, file) {
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
  player.onerror = null;
  clearStallTimer();
  player.src = `/transcode/${infoHash}/${file.index}`;
  playerInfo.textContent = `${file.name} (compatibility mode - seeking disabled)`;
  compatBtn.textContent = 'Playing in compatibility mode';
  compatBtn.disabled = true;
  player.play().catch(() => {});
}

// HLS: iOS plays .m3u8 natively via a plain <video src>, no library needed. The playlist grows
// as the server transcodes more of the file, which is also what lets seeking work here.
function playHls(infoHash, file) {
  player.onerror = null;
  clearStallTimer();
  player.src = `/hls/${infoHash}/${file.index}/playlist.m3u8`;
  playerInfo.textContent = `${file.name} (compatibility mode)`;
  compatBtn.textContent = 'Playing in compatibility mode';
  compatBtn.disabled = true;
  player.play().catch(() => {});
}

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
