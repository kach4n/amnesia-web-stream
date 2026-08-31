import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import { log, logError } from './log.js';

// iOS (Safari and every iOS "browser", since Apple forces them all onto WebKit) refuses to
// progressively play an indefinite-duration fragmented MP4 over plain HTTP - it only knows how
// to stream video via HLS (an .m3u8 playlist + small segment files). This manager transcodes a
// torrent file to HLS on the fly so iPhones can play files/codecs their browser can't handle
// directly (e.g. .mkv, HEVC, AC3/DTS).
//
// ffmpeg reads via our own /stream HTTP endpoint (not a raw pipe) rather than having the piece
// data piped into its stdin. Two things fall out of that: ffmpeg's HTTP client can issue Range
// requests, so `-ss` before `-i` gives us real input seeking (used to implement seeking: a seek
// just restarts ffmpeg pointed at a new offset) - and whatever ffmpeg reads flows through the
// same /stream route as direct playback, so it automatically benefits from that route's
// windowed-download prioritization instead of needing its own separate logic.
//
// Segments are written to a temp directory (not kept in memory) since a transcoded two-hour
// movie can run to gigabytes - the source torrent data itself stays memory-only, this is just a
// small transient cache that's deleted when the session ends.
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

  /** Get the session already running at this start offset, or (re)start one - a different
   *  startSeconds than what's currently running means the caller is seeking, so the old ffmpeg
   *  process is killed and a fresh one spawned at the new offset. */
  start(infoHash, fileIndex, streamUrl, startSeconds) {
    const key = this._key(infoHash, fileIndex);
    const existing = this.sessions.get(key);
    if (existing && existing.startSeconds === startSeconds) {
      existing.lastAccessed = Date.now();
      return existing;
    }
    if (existing) {
      log('hls', `seek - restarting ${key} at t=${startSeconds}s (was t=${existing.startSeconds}s)`);
      existing.ffmpeg.kill('SIGKILL'); // superseded - its exit handler cleans it up
    } else {
      log('hls', `session started - ${key} at t=${startSeconds}s`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amnesia-web-stream-hls-'));
    const sessionId = crypto.randomBytes(8).toString('hex');

    // Segment filenames/paths are kept relative (via cwd) so the playlist ffmpeg writes
    // contains bare names like "seg00000.ts" that we can safely rewrite into request URLs - an
    // absolute path here would end up baked into the playlist entries instead.
    const args = [];
    if (startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push(
      '-i', streamUrl,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_segment_filename', 'seg%05d.ts',
      'playlist.m3u8',
    );

    const ffmpeg = spawn(ffmpegPath, args, { cwd: dir });
    ffmpeg.stderr.on('data', () => {}); // swallow ffmpeg's verbose progress/logging
    ffmpeg.on('error', (err) => logError('hls', err.message));

    const session = {
      key, dir, sessionId, ffmpeg, startSeconds,
      playlistPath: path.join(dir, 'playlist.m3u8'),
      lastAccessed: Date.now(),
    };

    const cleanup = () => {
      if (this.sessions.get(key) === session) {
        this.sessions.delete(key);
        log('hls', `session ended - ${key}`);
      }
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

  stopAllForTorrent(infoHash) {
    for (const session of this.sessions.values()) {
      if (session.key.startsWith(`${infoHash}:`)) {
        log('hls', `stopping ${session.key} (torrent no longer being served)`);
        session.ffmpeg.kill('SIGKILL');
      }
    }
  }

  _sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastAccessed > IDLE_TIMEOUT_MS) {
        log('hls', `idle timeout - killing ${session.key} (no playlist/segment request in ${Math.round(IDLE_TIMEOUT_MS / 1000)}s)`);
        session.ffmpeg.kill('SIGKILL');
      }
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
