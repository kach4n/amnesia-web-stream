import { PassThrough } from 'node:stream';

/**
 * Reads [start, end] of a torrent file as one continuous stream, but internally sources it from
 * a rolling series of bounded (chunkBytes-sized) reads rather than one big one.
 *
 * Why: file.createReadStream({ start, end: fileSize - 1 }) - the natural way to serve an
 * open-ended Range request - makes WebTorrent prioritize downloading everything from `start` to
 * the end of the file in one go, because that's how its per-stream piece selection works. That's
 * the "streaming a file downloads the whole torrent" problem. Capping the *HTTP response* short
 * instead (returning fewer bytes than an open-ended range implies, expecting the client to just
 * ask again) seems like the fix, but breaks ffmpeg's http input - it treats a response for an
 * open-ended range that ends before the file's declared total size as a corrupt/truncated stream
 * and aborts, rather than issuing a follow-up request (verified directly against ffmpeg 6.1).
 *
 * So instead, the response is never short - the client always gets the full range it asked for,
 * gaplessly - but under the hood we serve it from consecutive bounded sub-reads. Each one only
 * keeps ~chunkBytes worth of pieces prioritized at a time (via WebTorrent's own per-stream
 * select/deselect, unchanged), so at most a rolling window is ever actively being fetched instead
 * of the whole remaining file.
 */
export function createWindowedReadStream(file, { start, end, chunkBytes }) {
  const out = new PassThrough();
  let pos = start;
  let destroyed = false;
  let currentSub = null;

  function next() {
    if (destroyed) return;
    if (pos > end) {
      out.end();
      return;
    }
    const chunkEnd = Math.min(end, pos + chunkBytes - 1);
    currentSub = file.createReadStream({ start: pos, end: chunkEnd });
    pos = chunkEnd + 1;
    currentSub.on('error', (err) => { if (!destroyed) out.destroy(err); });
    currentSub.pipe(out, { end: false });
    currentSub.once('end', next);
  }
  next();

  out.on('close', () => {
    destroyed = true;
    currentSub?.destroy();
  });

  return out;
}
