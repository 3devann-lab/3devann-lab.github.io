// SABER//3D — BeatLeader API proxy (Cloudflare Worker)
// BeatLeader's API only allows its own website to call it from a browser.
// This worker forwards read-only requests to api.beatleader.xyz and adds the
// CORS header so the game can use player search, scores and leaderboards.
// It only proxies GET requests to the BeatLeader API — nothing else.

const UPSTREAM = 'https://api.beatleader.xyz';
// Lock this down to your site, e.g. 'https://evanblokender.org'. '*' works anywhere.
const ALLOW_ORIGIN = '*';

export default {
    async fetch(request) {
        const cors = {
            'Access-Control-Allow-Origin': ALLOW_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

        const url = new URL(request.url);
        const target = UPSTREAM + url.pathname + url.search;
        const upstream = await fetch(target, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'saber3d-proxy' },
            cf: { cacheTtl: 30, cacheEverything: true },
        });
        const headers = new Headers(upstream.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.delete('set-cookie');
        return new Response(upstream.body, { status: upstream.status, headers });
    },
};
