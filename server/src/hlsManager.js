import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

// iOS (Safari and every iOS "browser", since Apple forces them all onto WebKit) refuses to
// progressively play an indefinite-duration fragmented MP4 over plain HTTP - it only knows how
// to stream video via HLS (an .m3u8 playlist + small segment files). This manager transcodes a
// torrent file to HLS on the fly so iPhones can play files/codecs their browser can't handle
// directly (e.g. .mkv, HEVC, AC3/DTS).
//
// Segments are written to a temp directory (not kept in memory) since a transcoded two-hour
// movie can run to gigabytes - the source torrent data itself stays memory-only as before,
// this is just a small transient cache that's deleted when the session ends.
export const SEGMENT_NAME_RE = /^seg\d{5}\.ts$/;

const IDLE_TIMEOUT_MS = 60_000; // kill ffmpeg if nobody has polled the playlist/segments in a while
const SWEEP_INTERVAL_MS = 15_000;

class HlsManager {
  constructor() {
    this.sessions = new Map(); // key: `${infoHash}:${fileIndex}` -> session
    setInterval(() => this._sweep(), SWEEP_INTERVAL_MS).unref();
    process.on('exit', () => this._cleanupAllSync());
  }

  _key(infoHash, fileIndex) {
    return `${infoHash}:${fileIndex}`;
  }

  /** Get the existing session for this file, or start a fresh ffmpeg HLS transcode for it. */
  getOrCreate(infoHash, fileIndex, file) {
    const key = this._key(infoHash, fileIndex);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-streamio-hls-'));
    const sessionId = crypto.randomBytes(8).toString('hex');
    const playlistPath = path.join(dir, 'playlist.m3u8');

    // Segment filenames/paths are kept relative (via cwd below) so the playlist ffmpeg writes
    // contains bare names like "seg00000.ts" that we can safely rewrite into request URLs -
    // an absolute path here would end up baked into the playlist entries instead.
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_segment_filename', 'seg%05d.ts',
      'playlist.m3u8',
    ], { cwd: dir });

    const input = file.createReadStream();
    input.pipe(ffmpeg.stdin);
    ffmpeg.stderr.on('data', () => {}); // swallow ffmpeg's verbose progress/logging
    ffmpeg.on('error', (err) => console.error('[hls ffmpeg]', err.message));

    const session = { key, dir, sessionId, ffmpeg, input, playlistPath, lastAccessed: Date.now() };

    const cleanup = () => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      input.destroy();
      try { ffmpeg.stdin.destroy(); } catch { /* already closed */ }
      fs.rm(dir, { recursive: true, force: true }, () => {});
    };
    ffmpeg.on('exit', cleanup);

    this.sessions.set(key, session);
    return session;
  }

  /** Resolves once the playlist has at least one segment in it, or rejects after timeoutMs. */
  async waitForPlaylist(session, timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.sessions.get(session.key) !== session) {
        throw new Error('HLS session ended before producing any output (ffmpeg likely failed)');
      }
      try {
        const contents = fs.readFileSync(session.playlistPath, 'utf8');
        if (contents.includes('.ts')) return contents;
      } catch {
        // playlist file doesn't exist yet - keep waiting
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Timed out waiting for HLS transcode to produce its first segment');
  }

  segmentPath(infoHash, fileIndex, sessionId, segmentName) {
    const session = this.sessions.get(this._key(infoHash, fileIndex));
    if (!session || session.sessionId !== sessionId) return null;
    session.lastAccessed = Date.now();
    if (!SEGMENT_NAME_RE.test(segmentName)) return null;
    return path.join(session.dir, segmentName);
  }

  stop(infoHash, fileIndex) {
    const session = this.sessions.get(this._key(infoHash, fileIndex));
    if (session) session.ffmpeg.kill('SIGKILL');
  }

  stopAllForTorrent(infoHash) {
    for (const session of this.sessions.values()) {
      if (session.key.startsWith(`${infoHash}:`)) session.ffmpeg.kill('SIGKILL');
    }
  }

  _sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastAccessed > IDLE_TIMEOUT_MS) session.ffmpeg.kill('SIGKILL');
    }
  }

  _cleanupAllSync() {
    for (const session of this.sessions.values()) {
      try { session.ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
      try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export const hlsManager = new HlsManager();
