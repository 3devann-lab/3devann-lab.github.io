# BeatLeader proxy (optional)

The replay browser searches players and levels through the BeatLeader API.
BeatLeader only lets its own website call that API from a browser, so the game
tries a few public CORS proxies when it's hosted anywhere else. Those are free
services and sometimes go down or rate-limit.

For reliable access, deploy this tiny proxy on Cloudflare Workers (free tier):

1. Sign in at https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Replace the example code with the contents of `cloudflare-worker.js` and click **Deploy**.
3. Copy the worker URL (looks like `https://saber3d-bl.yourname.workers.dev`).
4. In the game: **Settings → BeatLeader Proxy**, paste the URL.

Optional: set `ALLOW_ORIGIN` in the worker to your site's origin
(e.g. `https://evanblokender.org`) so only your page can use it.

The setting also accepts a generic CORS proxy with a `{url}` placeholder,
e.g. `https://my-proxy.example/?url={url}`.

Replays you already have don't need any of this: open a `.bsor` file, or paste
a `cdn.replays.beatleader.xyz/....bsor` link, from **Replays → File / Link**.
Replay files and BeatSaver map downloads are fetched directly.
