import WebTorrent from 'webtorrent';
import MemoryChunkStore from 'memory-chunk-store';
import path from 'node:path';
import { hlsManager } from './hlsManager.js';
import { getCachedDuration, probeDuration } from './mediaProbe.js';
import { log, logError } from './log.js';

// How much of a file to keep prioritized for download at a time (see windowedStream.js),
// instead of eagerly fetching the whole torrent into memory. Estimated in bytes using the file's
// bitrate (length / duration) once known; FALLBACK_BYTES_PER_SECOND is used as a rough guess
// before duration has been probed.
const WINDOW_CHUNK_SECONDS = 3 * 60;
const FALLBACK_BYTES_PER_SECOND = 900_000; // ~7.2 Mbps, a generous guess for a typical 1080p rip
const MIN_CHUNK_BYTES = 1_000_000;

// The frontend sends a heartbeat (its current playback position) every few seconds while a file
// is loaded in the player - that's the only signal that counts as "someone is actually watching".
// Without one, background activity (most notably: an HLS ffmpeg session, which keeps transcoding
// and pulling source data on its own schedule regardless of whether the viewer is still fetching
// segments) would otherwise keep downloading indefinitely even with no client attached.
//
// If a torrent hasn't gotten a heartbeat in WATCH_TIMEOUT_MS, any of its streams still being
// served are forcibly closed. If it hasn't gotten one in the much longer IDLE_RESET_MS, its
// downloaded pieces are dropped entirely and it's silently re-added (same magnet -> same
// infoHash) so it reappears in the list at 0% instead of holding everything it ever downloaded
// in memory indefinitely.
const WATCH_TIMEOUT_MS = 20_000;
const IDLE_RESET_MS = 5 * 60 * 1000;
const ACTIVITY_SWEEP_INTERVAL_MS = 5_000;

// Caps total download bandwidth across all torrents, bytes/sec.
const DOWNLOAD_LIMIT_BYTES_PER_SEC = 4 * 1024 * 1024;

// Video/audio extensions we consider "playable" in a <video>/<audio> tag.
const PLAYABLE_EXT = new Set([
  '.mp4', '.webm', '.mkv', '.m4v', '.mov', '.avi',
  '.mp3', '.m4a', '.wav', '.ogg', '.flac',
]);

// Many magnet links (e.g. from Torrentio) omit trackers entirely and rely on DHT alone,
// which can be slow or fail outright depending on the network. Appending a curated list of
// reliable public trackers dramatically speeds up peer discovery regardless of the source.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.opentrackr.org:1337',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com',
];

/**
 * Some torrent sources (e.g. Torrentio) produce magnet links whose `dn` field contains
 * raw newlines/pipes that, once percent-decoded, trip up webtorrent's internal URL parsing
 * and silently corrupt the whole parse (infoHash ends up undefined and it crashes the process).
 * Rebuild a minimal, clean magnet URI containing only what we actually need, and make sure
 * a solid set of trackers is always present so peer discovery isn't left to DHT alone.
 */
function sanitizeTorrentId(input) {
  const trimmed = input.trim();
  if (!/^magnet:/i.test(trimmed)) return trimmed; // http(s) .torrent URL or raw info hash - leave as-is

  const btih = trimmed.match(/xt=urn:btih:([a-zA-Z0-9]+)/i)?.[1];
  if (!btih) return trimmed; // not a recognizable magnet - let webtorrent surface its own error

  const params = [`xt=urn:btih:${btih}`];

  const dnRaw = trimmed.match(/[?&]dn=([^&]*)/i)?.[1];
  if (dnRaw) {
    let name;
    try {
      name = decodeURIComponent(dnRaw.replace(/\+/g, ' '));
    } catch {
      name = dnRaw;
    }
    name = name.replace(/\s+/g, ' ').trim();
    if (name) params.push(`dn=${encodeURIComponent(name)}`);
  }

  const trackers = new Set(DEFAULT_TRACKERS);
  for (const match of trimmed.matchAll(/[?&]tr=([^&]*)/gi)) {
    try {
      trackers.add(decodeURIComponent(match[1]));
    } catch {
      trackers.add(match[1]);
    }
  }
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);

  return `magnet:?${params.join('&')}`;
}

class TorrentManager {
  constructor() {
    // UPnP/NAT-PMP port mapping often fails with EACCES on Windows (unrelated to admin
    // rights) and isn't needed for LAN use, so it's disabled. Port-forward manually for WAN access.
    this.client = new WebTorrent({
      natUpnp: false,
      natPmp: false,
      downloadLimit: DOWNLOAD_LIMIT_BYTES_PER_SEC,
    });
    this.client.on('error', (err) => logError('webtorrent', err.message));

    this.originalIds = new Map(); // infoHash -> the torrentId it was added with (for idle re-add)
    this.lastHeartbeat = new Map(); // infoHash -> timestamp of the last client heartbeat
    this.watching = new Set(); // infoHash currently considered watched (heartbeat within WATCH_TIMEOUT_MS)
    this.activeStreams = new Map(); // infoHash -> Set of in-flight /stream response streams
    this.resetting = new Set(); // infoHash currently mid idle-reset
    this.port = null;

    setInterval(() => this._sweepActivity(), ACTIVITY_SWEEP_INTERVAL_MS).unref();
  }

  /** The server's own port, needed to build a loopback URL to /stream (used to probe duration
   *  and to let ffmpeg read a file over HTTP instead of a raw pipe - see hlsManager.js). */
  setPort(port) {
    this.port = port;
  }

  _streamUrl(infoHash, fileIndex) {
    return `http://127.0.0.1:${this.port}/stream/${infoHash}/${fileIndex}`;
  }

  /** Record that a client is still watching `fileIndex` of this torrent at `position` seconds.
   *  This is the only thing that counts as "someone is watching" - see the comment above
   *  WATCH_TIMEOUT_MS for why plain /stream HTTP activity isn't used for this instead. */
  heartbeat(infoHash, fileIndex, position) {
    this.lastHeartbeat.set(infoHash, Date.now());
    if (!this.watching.has(infoHash)) {
      this.watching.add(infoHash);
      log('heartbeat', `client connected - ${infoHash} file ${fileIndex} @ ${Math.round(position)}s`);
    }
  }

  /** Track an in-flight /stream response stream so it can be force-closed if the client stops
   *  heartbeating (see _sweepActivity). Removes itself once the stream ends on its own. */
  registerStream(infoHash, stream) {
    let streams = this.activeStreams.get(infoHash);
    if (!streams) {
      streams = new Set();
      this.activeStreams.set(infoHash, streams);
    }
    streams.add(stream);
    stream.once('close', () => streams.delete(stream));
  }

  /** Add a torrent by magnet URI, .torrent URL, or info hash. Resolves once metadata is ready. */
  add(torrentId) {
    torrentId = sanitizeTorrentId(torrentId);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        torrent?.destroy({ destroyStore: true }, () => {});
        logError('torrent', `add timed out waiting for metadata: ${torrentId.slice(0, 80)}`);
        reject(new Error(
          'Timed out fetching torrent metadata after 60s. No peers responded, which usually means outbound ' +
          'BitTorrent traffic (TCP/UDP) is blocked by a firewall/router/VPN on this machine or network, ' +
          'rather than the torrent lacking seeders.'
        ));
      }, 60_000);

      let torrent;
      try {
        // client.add() de-dupes internally by info hash, so no need to check for an existing torrent first.
        // Pieces are kept in memory only (never written to disk) so nothing persists on server storage.
        // `deselect: true` is critical: without it, WebTorrent selects every piece of every file
        // the moment metadata is ready (torrent.js's default `select(0, pieces.length - 1)`) and
        // starts downloading the whole thing immediately, regardless of what's actually being
        // played - focusFile()/windowedStream.js would only ever be fighting that default, not
        // controlling what downloads. With it, nothing downloads until something explicitly
        // selects it (which only happens as a file is actually being read).
        torrent = this.client.add(torrentId, { store: MemoryChunkStore, deselect: true }, (readyTorrent) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.originalIds.set(readyTorrent.infoHash, torrentId);
          log('torrent', `added "${readyTorrent.name || readyTorrent.infoHash}" (${readyTorrent.infoHash}, ${readyTorrent.files.length} files)`);
          resolve(this._serialize(readyTorrent));
        });
      } catch (err) {
        clearTimeout(timeout);
        return reject(err);
      }

      torrent.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        logError('torrent', `add failed: ${err.message || err}`);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Synchronous lookup by info hash (client.get() in this webtorrent version is async, so avoid it here). */
  get(infoHash) {
    return this.client.torrents.find((t) => t.infoHash === infoHash) || null;
  }

  list() {
    return this.client.torrents.map((t) => this._serialize(t));
  }

  status(infoHash) {
    const torrent = this.get(infoHash);
    if (!torrent) return null;
    return this._serialize(torrent);
  }

  remove(infoHash) {
    return new Promise((resolve, reject) => {
      const torrent = this.get(infoHash);
      if (!torrent) return resolve(false);
      log('torrent', `removed "${torrent.name || infoHash}" (${infoHash})`);
      this._stopServing(infoHash);
      this._forgetTracking(infoHash);
      torrent.destroy({ destroyStore: true }, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  _forgetTracking(infoHash) {
    this.originalIds.delete(infoHash);
    this.lastHeartbeat.delete(infoHash);
    this.watching.delete(infoHash);
    this.activeStreams.delete(infoHash);
  }

  /** Deprioritize every other file so the one being streamed gets bandwidth first - the file
   *  itself isn't blanket-selected here; windowedStream.js keeps only a rolling window of it
   *  prioritized as it's actually read, so we don't eagerly download the whole thing just
   *  because playback started. */
  focusFile(infoHash, fileIndex) {
    const torrent = this.get(infoHash);
    if (!torrent) return;
    torrent.files.forEach((f, i) => {
      if (i !== fileIndex) f.deselect();
    });
  }

  /** How many bytes of a file to fetch per bounded internal read in windowedStream.js - roughly
   *  WINDOW_CHUNK_SECONDS worth, estimated from the file's bitrate (length / duration) once
   *  known, kicking off a duration probe if it isn't yet. */
  getChunkBytes(infoHash, fileIndex) {
    const duration = getCachedDuration(infoHash, fileIndex);
    if (duration == null) probeDuration(infoHash, fileIndex, this._streamUrl(infoHash, fileIndex));

    const torrent = this.get(infoHash);
    const file = torrent?.files[fileIndex];
    const bytesPerSecond = (duration && file) ? file.length / duration : FALLBACK_BYTES_PER_SECOND;

    return Math.max(MIN_CHUNK_BYTES, Math.round(bytesPerSecond * WINDOW_CHUNK_SECONDS));
  }

  /** Force-close anything currently being served for this torrent - in-flight /stream responses
   *  and any HLS transcode session - because nobody's heartbeated recently enough to still count
   *  as watching it. Safe to call repeatedly; closing an already-closed stream/session is a no-op. */
  _stopServing(infoHash) {
    const streams = this.activeStreams.get(infoHash);
    if (streams) for (const stream of streams) stream.destroy();
    hlsManager.stopAllForTorrent(infoHash);
  }

  /** Two-tier response to a torrent going unwatched (see the comment above WATCH_TIMEOUT_MS):
   *  past WATCH_TIMEOUT_MS, stop actively serving/downloading it; past the much longer
   *  IDLE_RESET_MS, wipe what's downloaded and silently re-add it (same magnet -> same infoHash)
   *  so it goes back to 0% in the list. */
  _sweepActivity() {
    const now = Date.now();
    for (const torrent of this.client.torrents) {
      const infoHash = torrent.infoHash;
      const last = this.lastHeartbeat.get(infoHash);
      if (last == null || this.resetting.has(infoHash)) continue;

      const idleMs = now - last;

      if (idleMs > WATCH_TIMEOUT_MS) {
        if (this.watching.has(infoHash)) {
          this.watching.delete(infoHash);
          log('heartbeat', `stopped - ${infoHash} idle for ${Math.round(idleMs / 1000)}s, closing active streams/HLS sessions`);
        }
        this._stopServing(infoHash);
      }

      if (idleMs > IDLE_RESET_MS && torrent.progress > 0) {
        const originalId = this.originalIds.get(infoHash);
        if (!originalId) continue;

        this.resetting.add(infoHash);
        this._stopServing(infoHash);
        this._forgetTracking(infoHash);

        log('torrent', `idle reset - wiping "${torrent.name || infoHash}" (was ${Math.round(torrent.progress * 100)}% downloaded, no heartbeat for ${Math.round(idleMs / 1000)}s)`);

        torrent.destroy({ destroyStore: true }, () => {
          this.add(originalId)
            .catch((err) => logError('torrent', `idle reset - failed to re-add: ${err.message}`))
            .finally(() => this.resetting.delete(infoHash));
        });
      }
    }
  }

  _serialize(torrent) {
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      length: torrent.length,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      ready: torrent.ready,
      done: torrent.done,
      files: (torrent.files || []).map((f, index) => ({
        index,
        name: f.name,
        length: f.length,
        path: f.path,
        playable: PLAYABLE_EXT.has(path.extname(f.name).toLowerCase()),
        progress: f.progress ?? 0,
      })),
    };
  }
}

export const torrentManager = new TorrentManager();
