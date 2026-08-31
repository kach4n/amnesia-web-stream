import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';
import { torrentManager } from './torrentManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PORT = process.env.PORT || 3000;

// A single malformed torrent (bad metadata, dependency bug, etc.) should never take down
// the whole server - log it and keep serving other torrents/requests.
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));

const app = express();
app.use(cors());
app.use(express.json());

// ---- API ----

app.get('/api/torrents', (req, res) => {
  res.json(torrentManager.list());
});

app.post('/api/torrents', async (req, res) => {
  const { torrentId } = req.body || {};
  if (!torrentId || typeof torrentId !== 'string') {
    return res.status(400).json({ error: 'torrentId (magnet link, .torrent URL, or info hash) is required' });
  }
  try {
    const torrent = await torrentManager.add(torrentId.trim());
    res.status(201).json(torrent);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/torrents/:infoHash', (req, res) => {
  const torrent = torrentManager.status(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });
  res.json(torrent);
});

app.delete('/api/torrents/:infoHash', async (req, res) => {
  const removed = await torrentManager.remove(req.params.infoHash);
  if (!removed) return res.status(404).json({ error: 'Torrent not found' });
  res.status(204).end();
});

// ---- Streaming ----

app.get('/stream/:infoHash/:fileIndex', (req, res) => {
  const torrent = torrentManager.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  const fileIndex = Number(req.params.fileIndex);
  const file = torrent.files[fileIndex];
  if (!file) return res.status(404).json({ error: 'File not found in torrent' });

  torrentManager.focusFile(req.params.infoHash, fileIndex);

  const fileSize = file.length;
  const contentType = mime.lookup(file.name) || 'application/octet-stream';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    file.createReadStream().pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    return res.end();
  }

  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });

  const stream = file.createReadStream({ start, end });
  stream.pipe(res);
  stream.on('error', () => res.end());
  req.on('close', () => stream.destroy());
});

// ---- Static frontend ----
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/stream')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`web-streamio server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-lan-ip>:${PORT}`);
});
