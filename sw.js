// AlbAppTV Service Worker
// Fängt /sw-proxy?url=...&ua=... Requests ab,
// setzt den richtigen User-Agent und rewrites m3u8-URLs.

const UA_DEFAULT = 'stagefright/1.2 (Linux;Android 7.1.2)';
const PROXY_PATH = 'sw-proxy'; // matched via pathname.endsWith

// ── URL resolver ─────────────────────────────────────────────
function resolveUrl(target, base) {
    try {
        if (target.startsWith('http://') || target.startsWith('https://')) return target;
        const b = new URL(base);
        if (target.startsWith('/')) return b.protocol + '//' + b.host + target;
        const dir = base.substring(0, base.lastIndexOf('/') + 1);
        return dir + target;
    } catch { return target; }
}

// ── H.264 filter for master playlists ────────────────────────
function filterMaster(content) {
    const lines = content.split('\n');
    if (!lines.some(l => l.trim().startsWith('#EXT-X-STREAM-INF'))) return content;

    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('#EXT-X-STREAM-INF')) {
            const u = (lines[i+1] || '').trim();
            if (u) variants.push({ inf: lines[i].trim(), url: u });
        }
    }

    const h264 = variants.filter(v => v.inf.includes('avc1'));
    if (!h264.length) return content;

    const best = h264.sort((a, b) => {
        const bw = s => parseInt((s.match(/BANDWIDTH=(\d+)/) || [0,0])[1]) || 0;
        return bw(b.inf) - bw(a.inf);
    })[0];

    const header = lines.filter(l => {
        const t = l.trim();
        return t.startsWith('#EXTM3U') || t.startsWith('#EXT-X-VERSION') || t.startsWith('#EXT-X-INDEPENDENT');
    });
    return [...header, best.inf, best.url, ''].join('\n');
}

// ── M3U8 URL rewriter ─────────────────────────────────────────
function rewriteM3U8(content, baseUrl, ua) {
    const filtered = filterMaster(content);
    return filtered.split('\n').map(rawLine => {
        const line = rawLine.trim();
        if (!line) return rawLine;
        if (line.startsWith('#') && line.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                const abs = resolveUrl(uri, baseUrl);
                return `URI="sw-proxy?url=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}"`;
            });
        }
        if (!line.startsWith('#')) {
            const abs = resolveUrl(line, baseUrl);
            return `sw-proxy?url=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}`;
        }
        return rawLine;
    }).join('\n');
}

// ── Fetch handler ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const reqUrl = new URL(event.request.url);
    if (!reqUrl.pathname.endsWith('/sw-proxy')) return;

    const targetUrl = reqUrl.searchParams.get('url');
    const ua = reqUrl.searchParams.get('ua') || UA_DEFAULT;
    if (!targetUrl) return;

    event.respondWith((async () => {
        try {
            const resp = await fetch(targetUrl, {
                headers: { 'User-Agent': ua, 'Accept': '*/*' },
            });

            const ct = resp.headers.get('content-type') || '';
            const isM3U8 = ct.includes('mpegurl') || ct.includes('m3u') ||
                           targetUrl.includes('.m3u8') || targetUrl.includes('.m3u');

            const headers = new Headers({
                'Access-Control-Allow-Origin': '*',
                'Content-Type': isM3U8 ? 'application/vnd.apple.mpegurl' : (ct || 'application/octet-stream'),
            });
            for (const h of ['cache-control', 'last-modified', 'etag', 'accept-ranges', 'content-range']) {
                if (resp.headers.has(h)) headers.set(h, resp.headers.get(h));
            }

            if (isM3U8) {
                const body = await resp.text();
                const rewritten = rewriteM3U8(body, targetUrl, ua);
                return new Response(rewritten, { status: resp.status, headers });
            } else {
                return new Response(resp.body, { status: resp.status, headers });
            }
        } catch (e) {
            return new Response('SW Proxy error: ' + e.message, { status: 502 });
        }
    })());
});

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
