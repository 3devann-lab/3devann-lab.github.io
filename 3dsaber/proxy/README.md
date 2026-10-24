# BeatLeader proxy (makes player & level search work)

BeatLeader only lets its own website (and `localhost` dev ports) read player and level
data from a browser. On any other site, like evanblokender.org, **Players** and **Levels**
search need a small proxy in between.

The game uses `https://shy-mud-5208.3devann.workers.dev` by default (set in `js/beatleader.js`,
`DEFAULT_PROXY`). Redeploying it with the current `cloudflare-worker.js` adds a `/health` page and
automatic failover between api.beatleader.com and api.beatleader.xyz. Anyone can point the game at a
different worker in **Settings → BeatLeader Proxy**, or type `off` to use only the free public relays
(slow and often down).

Things that work **without** a proxy:
- **Replays → Live**: every replay set on BeatLeader appears the moment it's set (you can filter by player or song)
- **Replays → File / Link**: open a `.bsor` file or paste a `cdn.replays.beatleader…/….bsor` link

## Set it up (free, about 2 minutes)

1. Sign in at https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it (e.g. `saber3d-bl`), click **Deploy**, then **Edit code**.
3. Replace all of the code with the contents of `cloudflare-worker.js` and click **Deploy** again.
4. Open the worker's URL (`https://saber3d-bl.<you>.workers.dev`) in a browser tab — you should see
   `{"ok":true,"service":"saber3d-beatleader-proxy",…}`. If you do, it's live.
5. In the game: **Settings → BeatLeader Proxy**, paste the URL (with or without `https://`) and press **Test**.
   It should say **Works ✓**. Player and level search now load in about a second.

If **Test** shows an error, it tells you what went wrong — e.g. a typo in the URL, or the
worker still running old code (redeploy step 3).

Optional: set `ALLOW_ORIGIN` in the worker to `https://evanblokender.org` so only your page can use it.

The setting also accepts a generic CORS proxy with a `{url}` placeholder,
e.g. `https://my-proxy.example/?url={url}`.
