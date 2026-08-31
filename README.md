# web-streamio

Stream any torrent (magnet link, `.torrent` URL, or info hash) directly to a browser — no download-and-wait, no desktop app. Run the server on one computer, then open the web page from your phone, tablet, or any other device on the same network (or over the internet, if you expose it).

Think of it as a tiny, self-hosted Stremio-style streaming server.

## How it works

- **Backend**: Node.js + [Express](https://expressjs.com/) + [WebTorrent](https://webtorrent.io/). WebTorrent downloads torrent pieces and lets us read a file as a stream while it's still downloading. The server exposes that as an HTTP endpoint that supports `Range` requests, which is exactly what HTML5 `<video>` needs to seek/scrub through a video while it streams.
- **Frontend**: a small static HTML/CSS/JS page (no build step) served by the same Express server. It lets you paste a magnet link, see the torrent's files, and play any video/audio file in the browser's native player.

Everything lives in this one repo/server — there's nothing else to deploy.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer

## Setup & run

```bash
cd server
npm install
npm start
```

You'll see something like:

```
web-streamio server running:
  Local:   http://localhost:3000
  Network: http://<your-lan-ip>:3000
```

- Open `http://localhost:3000` on the same computer, or
- Open `http://<your-lan-ip>:3000` from your phone/tablet while connected to the **same Wi-Fi/LAN**.

To find `<your-lan-ip>`:
- Windows: `ipconfig` → look for "IPv4 Address"
- macOS/Linux: `ifconfig` or `ip addr` → look for your Wi-Fi/LAN adapter's `inet` address

### Changing the port

```bash
# Windows PowerShell
$env:PORT=8080; npm start

# macOS/Linux
PORT=8080 npm start
```

### Auto-restart during development

```bash
npm run dev
```

## Using it

1. Paste a magnet link (`magnet:?xt=urn:btih:...`), a direct URL to a `.torrent` file, or a raw info hash into the input box and click **Add**.
2. Wait a few seconds while WebTorrent fetches the torrent's metadata from peers/trackers.
3. Once the file list appears, click **Play** next to any playable video/audio file.
4. The video starts playing immediately and keeps buffering in the background — seeking is supported once the corresponding pieces are downloaded.
5. Click **Remove** to stop seeding/downloading a torrent and free up disk space.

## Accessing it over the internet (WAN)

By default the server only exposed on your local network. To reach it from outside your home network you have a few options (pick one):

- **Port forward** your router: forward an external port to your computer's LAN IP on the port the server runs on (default `3000`), then use your public IP (or a dynamic DNS hostname) from outside.
- **Reverse tunnel** (no router config needed), e.g. [Tailscale](https://tailscale.com/), [ngrok](https://ngrok.com/), or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

> ⚠️ Exposing this server to the public internet gives anyone with the URL the ability to add/remove torrents on your machine. There's no authentication built in — if you expose it beyond your LAN, put it behind a VPN (Tailscale is the easiest) or add your own auth layer in front (e.g. a reverse proxy with basic auth).

## Project structure

```
web-streamio/
├── server/                # Node.js backend
│   ├── package.json
│   └── src/
│       ├── server.js          # Express app, REST API, range-request video streaming
│       └── torrentManager.js  # Wraps the WebTorrent client (add/list/remove/status)
├── public/                 # Static frontend (served by the backend, no build step)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## API reference

| Method | Endpoint                          | Description                                      |
|--------|------------------------------------|---------------------------------------------------|
| GET    | `/api/torrents`                    | List all active torrents and their files/status   |
| POST   | `/api/torrents`                    | Add a torrent. Body: `{ "torrentId": "magnet:..." }` |
| GET    | `/api/torrents/:infoHash`          | Get status/progress for one torrent               |
| DELETE | `/api/torrents/:infoHash`          | Stop and remove a torrent, deleting its data       |
| GET    | `/stream/:infoHash/:fileIndex`     | Stream a file as-is (supports `Range` requests)    |
| GET    | `/transcode/:infoHash/:fileIndex`  | Re-encode a file to H.264/AAC MP4 on the fly (compatibility fallback, no seeking) |

## Notes & limitations

- Torrent pieces are kept **in memory only** (never written to disk) - nothing persists on server storage. This means RAM usage grows while a torrent is active, and all downloaded data is lost when a torrent is removed or the server restarts.
- Playback format depends on your browser's native `<video>`/`<audio>` support. Desktop browsers are often more permissive (e.g. Windows Chrome/Edge can lean on OS codecs), while phones are stricter — `.mkv` files with HEVC/DTS audio, for example, commonly fail to play on mobile. If direct playback fails, the player automatically retries using the `/transcode` endpoint, which re-encodes the file on the fly to universally-supported H.264 video + AAC audio using [ffmpeg](https://ffmpeg.org/) (bundled via `ffmpeg-static`, no separate install needed). There's also a manual "Try compatibility mode" button in case a device doesn't report the error. Trade-off: transcoding uses CPU on the server and doesn't support seeking (the stream is generated sequentially, so you can only play from the start).
- There is no authentication — treat this as a trusted-network / personal-use tool.
- Only one server instance is needed; the frontend and backend are served from the same origin, so there's no CORS configuration to worry about.
