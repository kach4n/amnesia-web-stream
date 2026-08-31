import WebTorrent from 'webtorrent';
import MemoryChunkStore from 'memory-chunk-store';
import path from 'node:path';

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
    this.client = new WebTorrent({ natUpnp: false, natPmp: false });
    this.client.on('error', (err) => console.error('[webtorrent client error]', err.message));
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
        torrent = this.client.add(torrentId, { store: MemoryChunkStore }, (readyTorrent) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
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
      torrent.destroy({ destroyStore: true }, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }


  /** Deprioritize every file except the one being streamed so playback gets bandwidth first. */
  focusFile(infoHash, fileIndex) {
    const torrent = this.get(infoHash);
    if (!torrent) return;
    torrent.files.forEach((f, i) => {
      if (i === fileIndex) f.select();
      else f.deselect();
    });
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
