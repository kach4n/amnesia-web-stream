import { spawn } from 'node:child_process';
import ffprobePath from 'ffprobe-static';

// Duration is needed for the custom seek timeline and to estimate the file's bitrate (which
// drives how many bytes the windowed-download logic prefetches ahead of playback). ffprobe
// reads it straight from our own /stream endpoint - since that endpoint supports Range
// requests, ffprobe only pulls the small header/index region it needs, not the whole file.
const cache = new Map(); // `${infoHash}:${fileIndex}` -> { duration, promise }

function key(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`;
}

export function getCachedDuration(infoHash, fileIndex) {
  return cache.get(key(infoHash, fileIndex))?.duration ?? null;
}

/** Returns a promise for the duration (seconds), reusing an in-flight or cached probe. */
export function probeDuration(infoHash, fileIndex, streamUrl) {
  const k = key(infoHash, fileIndex);
  const existing = cache.get(k);
  if (existing) return existing.promise;

  const promise = new Promise((resolve) => {
    const ffprobe = spawn(ffprobePath.path, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      streamUrl,
    ]);
    let out = '';
    ffprobe.stdout.on('data', (chunk) => { out += chunk; });
    ffprobe.on('error', () => resolve(null));
    ffprobe.on('close', () => {
      try {
        const duration = Number(JSON.parse(out).format.duration);
        resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
      } catch {
        resolve(null);
      }
    });
  }).then((duration) => {
    cache.set(k, { duration, promise: Promise.resolve(duration) });
    return duration;
  });

  cache.set(k, { duration: null, promise });
  return promise;
}
