// SABER//3D — BeatLeader API proxy (Cloudflare Worker)
// BeatLeader's API only allows its own website to call it from a browser.
// This worker forwards read-only requests to the BeatLeader API and adds the
// CORS header so the game can use player search, scores and leaderboards.
// It only proxies GET requests to the BeatLeader API — nothing else.

// Tried in order; if one is down or refuses us, the next one is used.
const UPSTREAMS = ['https://api.beatleader.com', 'https://api.beatleader.xyz'];
// Lock this down to your site, e.g. 'https://evanblokender.org'. '*' works anywhere.
const ALLOW_ORIGIN = '*';

const CORS = {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

// errors need CORS headers too, or the browser hides them behind a CORS error
function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (request.method !== 'GET') return json({ error: 'Only GET is allowed' }, 405);

        const url = new URL(request.url);
        // opening the worker URL in a browser tab shows this — handy to check it's deployed
        if (url.pathname === '/' || url.pathname === '/health') {
            return json({ ok: true, service: 'saber3d-beatleader-proxy', try: '/players?search=cerret' });
        }

        let lastStatus = 502, lastError = 'BeatLeader did not answer';
        for (const base of UPSTREAMS) {
            try {
                const upstream = await fetch(base + url.pathname + url.search, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; saber3d-proxy/1.1)' },
                    cf: { cacheTtl: 30, cacheEverything: true },
                });
                if (upstream.status >= 500 || upstream.status === 403 || upstream.status === 429) {
                    lastStatus = upstream.status;
                    lastError = `BeatLeader answered ${upstream.status}`;
                    continue;
                }
                const headers = new Headers(upstream.headers);
                for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
                headers.delete('set-cookie');
                return new Response(upstream.body, { status: upstream.status, headers });
            } catch (e) {
                lastError = String((e && e.message) || e);
            }
        }
        return json({ error: lastError }, lastStatus);
    },
};
