import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import mime from 'mime-types';
import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs';
import { torrentManager } from './torrentManager.js';
import { hlsManager } from './hlsManager.js';
import { getCachedDuration, probeDuration } from './mediaProbe.js';
import { createWindowedReadStream } from './windowedStream.js';
import { log, logError } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PORT = process.env.PORT || 3000;
torrentManager.setPort(PORT);

function streamUrl(infoHash, fileIndex) {
  return `http://127.0.0.1:${PORT}/stream/${infoHash}/${fileIndex}`;
}

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

// The frontend pings this every few seconds while a file is loaded in the player, reporting
// where it currently is. It's the only signal the server trusts as "someone is watching" - see
// the comment above WATCH_TIMEOUT_MS in torrentManager.js for why. Sent via sendBeacon, so the
// body arrives as a Blob rather than a normal fetch JSON body, but express.json() parses either.
app.post('/api/torrents/:infoHash/heartbeat', (req, res) => {
  const { fileIndex, position } = req.body || {};
  torrentManager.heartbeat(req.params.infoHash, Number(fileIndex), Number(position) || 0);
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
  const chunkBytes = torrentManager.getChunkBytes(req.params.infoHash, fileIndex);

  const serve = (start, end) => {
    log('stream', `open - ${req.params.infoHash} file ${fileIndex} range ${start}-${end}`);
    const stream = createWindowedReadStream(file, { start, end, chunkBytes });
    torrentManager.registerStream(req.params.infoHash, stream);
    stream.pipe(res);
    stream.on('error', (err) => { logError('stream', `error - ${err.message}`); res.end(); });
    stream.once('close', () => log('stream', `closed - ${req.params.infoHash} file ${fileIndex}`));
    req.on('close', () => stream.destroy());
  };

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    serve(0, fileSize - 1);
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
  serve(start, end);
});

// ---- Transcoding (compatibility fallback) ----
// Some containers/codecs (e.g. .mkv with HEVC/DTS) that play fine on a desktop browser
// aren't supported at all on phones. Re-encode on the fly to widely-supported H.264/AAC MP4.
// Trades away seeking (no known duration/byte ranges for a live-encoded stream) for compatibility.
app.get('/transcode/:infoHash/:fileIndex', (req, res) => {
  const torrent = torrentManager.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  const fileIndex = Number(req.params.fileIndex);
  const file = torrent.files[fileIndex];
  if (!file) return res.status(404).json({ error: 'File not found in torrent' });

  torrentManager.focusFile(req.params.infoHash, fileIndex);
  log('transcode', `started - ${req.params.infoHash} file ${fileIndex}`);

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
  });

  // Reads via our own /stream endpoint (instead of piping file.createReadStream() straight into
  // ffmpeg's stdin) so this also benefits from /stream's windowed-download prioritization.
  const ffmpeg = spawn(ffmpegPath, [
    '-i', streamUrl(req.params.infoHash, fileIndex),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ]);

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', () => {}); // swallow ffmpeg's verbose progress/logging

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ffmpeg.kill('SIGKILL');
    log('transcode', `ended - ${req.params.infoHash} file ${fileIndex}`);
  };
  ffmpeg.on('error', (err) => logError('transcode', err.message));
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// ---- Duration probing (for the custom HLS seek timeline) ----
app.get('/api/torrents/:infoHash/files/:fileIndex/duration', async (req, res) => {
  const torrent = torrentManager.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  const fileIndex = Number(req.params.fileIndex);
  const file = torrent.files[fileIndex];
  if (!file) return res.status(404).json({ error: 'File not found in torrent' });

  const cached = getCachedDuration(req.params.infoHash, fileIndex);
  if (cached != null) return res.json({ duration: cached });

  const duration = await probeDuration(req.params.infoHash, fileIndex, streamUrl(req.params.infoHash, fileIndex));
  res.json({ duration });
});

// ---- HLS transcoding (iOS compatibility) ----
// iOS's browser engine (WebKit - this applies to "Chrome" on iOS too, Apple requires it) won't
// progressively play an indefinite-duration fragmented MP4 like /transcode produces above; it
// only knows how to stream via HLS. This transcodes to an .m3u8 playlist + .ts segments instead,
// which iOS plays natively.
//
// Real seeking: a `t` query param (seconds) tells ffmpeg to -ss seek its input before
// transcoding. Since native iOS HLS playback doesn't let us intercept seek gestures at the
// network level, the frontend implements seeking itself - it swaps the <video> src to this URL
// with a new `t`, which restarts transcoding from that offset (see the custom timeline in app.js).
app.get('/hls/:infoHash/:fileIndex/playlist.m3u8', async (req, res) => {
  const torrent = torrentManager.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  const fileIndex = Number(req.params.fileIndex);
  const file = torrent.files[fileIndex];
  if (!file) return res.status(404).json({ error: 'File not found in torrent' });

  torrentManager.focusFile(req.params.infoHash, fileIndex);

  const startSeconds = Math.max(0, Number(req.query.t) || 0);
  const session = hlsManager.start(req.params.infoHash, fileIndex, streamUrl(req.params.infoHash, fileIndex), startSeconds);
  try {
    const playlist = await hlsManager.waitForPlaylist(session);
    const rewritten = playlist.replace(
      /^(seg\d{5}\.ts)$/gm,
      (segName) => `/hls/${req.params.infoHash}/${fileIndex}/${session.sessionId}/${segName}`
    );
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
    });
    res.end(rewritten);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/hls/:infoHash/:fileIndex/:sessionId/:segment', (req, res) => {
  const fileIndex = Number(req.params.fileIndex);
  const segmentPath = hlsManager.segmentPath(req.params.infoHash, fileIndex, req.params.sessionId, req.params.segment);
  if (!segmentPath || !fs.existsSync(segmentPath)) return res.status(404).end();

  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' });
  fs.createReadStream(segmentPath).pipe(res);
});

// ---- Static frontend ----
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/stream')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Amnesia web-stream server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-lan-ip>:${PORT}`);
});
