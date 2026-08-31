const API = '/api/torrents';

const addForm = document.getElementById('add-form');
const torrentInput = document.getElementById('torrent-input');
const addBtn = document.getElementById('add-btn');
const addError = document.getElementById('add-error');
const torrentList = document.getElementById('torrent-list');
const playerSection = document.getElementById('player-section');
const player = document.getElementById('player');
const playerInfo = document.getElementById('player-info');

let torrents = [];
let pollTimer = null;

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

function playFile(infoHash, file) {
  const src = `/stream/${infoHash}/${file.index}`;
  player.src = src;
  playerSection.classList.remove('hidden');
  playerInfo.textContent = file.name;
  player.play().catch(() => {});
  playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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
